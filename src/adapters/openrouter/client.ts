import OpenAI from "openai";
import { z } from "zod";

import { LlmContractError } from "../../domain/errors";

/**
 * OpenRouter access via the OpenAI-compatible SDK (D1) with structured-output HARDENING
 * (D11): strict JSON Schema, `provider.require_parameters` so OpenRouter only routes to
 * providers that honour the schema, response validation at the boundary, and one bounded
 * re-ask before throwing a typed `LlmContractError`. Never returns unvalidated data.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterClientOptions {
  apiKey: string;
  baseURL?: string;
  /** Optional OpenRouter attribution headers. */
  appUrl?: string;
  appName?: string;
}

export function createOpenRouterClient(options: OpenRouterClientOptions): OpenAI {
  const defaultHeaders: Record<string, string> = {};
  if (options.appUrl) defaultHeaders["HTTP-Referer"] = options.appUrl;
  if (options.appName) defaultHeaders["X-Title"] = options.appName;
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? OPENROUTER_BASE_URL,
    defaultHeaders,
  });
}

type JsonObject = Record<string, unknown>;

/** Recursively enforce `additionalProperties:false` + full `required` for strict mode (D11). */
function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrict);
  if (node && typeof node === "object") {
    const obj = node as JsonObject;
    if (obj["type"] === "object" && obj["properties"] && typeof obj["properties"] === "object") {
      const props = obj["properties"] as JsonObject;
      obj["additionalProperties"] = false;
      obj["required"] = Object.keys(props);
    }
    for (const key of Object.keys(obj)) obj[key] = enforceStrict(obj[key]);
  }
  return node;
}

export function toStrictJsonSchema(schema: z.ZodType): JsonObject {
  return enforceStrict(z.toJSONSchema(schema)) as JsonObject;
}

export type UserContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

export interface StructuredCall<T> {
  model: string;
  system: string;
  user: UserContent;
  schema: z.ZodType<T>;
  schemaName: string;
  /** Optional fixed seed for best-effort reproducibility (D15). */
  seed?: number;
}

/**
 * Run one structured-output completion through OpenRouter and return validated data, with a
 * single re-ask on a contract mismatch. Throws {@link LlmContractError} if it still fails.
 */
export async function requestStructured<T>(client: OpenAI, call: StructuredCall<T>): Promise<T> {
  const jsonSchema = toStrictJsonSchema(call.schema);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: call.system },
    { role: "user", content: call.user as OpenAI.Chat.ChatCompletionUserMessageParam["content"] },
  ];

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = {
      model: call.model,
      messages,
      temperature: 0,
      ...(call.seed !== undefined ? { seed: call.seed } : {}),
      response_format: {
        type: "json_schema",
        json_schema: { name: call.schemaName, strict: true, schema: jsonSchema },
      },
      // OpenRouter-only: route only to providers that honour response_format (loud, not silent).
      provider: { require_parameters: true },
    };

    const completion = await client.chat.completions.create(
      body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    );
    const content = completion.choices[0]?.message.content ?? "";

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      lastError = "response was not valid JSON";
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `Your previous response was not valid JSON. Return ONLY a JSON object matching the schema "${call.schemaName}".`,
      });
      continue;
    }

    const result = call.schema.safeParse(parsedJson);
    if (result.success) return result.data;

    lastError = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: `Your previous response did not match the schema (${lastError}). Return ONLY corrected JSON.`,
    });
  }

  throw new LlmContractError(
    `OpenRouter response failed the "${call.schemaName}" contract: ${lastError}`,
    {
      details: { model: call.model, schemaName: call.schemaName },
    },
  );
}

/** A plain text completion (used by the painter, which returns HTML, not JSON). */
export async function requestText(
  client: OpenAI,
  params: { model: string; system: string; user: UserContent; seed?: number },
): Promise<string> {
  const completion = await client.chat.completions.create({
    model: params.model,
    temperature: 0,
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    messages: [
      { role: "system", content: params.system },
      {
        role: "user",
        content: params.user as OpenAI.Chat.ChatCompletionUserMessageParam["content"],
      },
    ],
  });
  return completion.choices[0]?.message.content ?? "";
}
