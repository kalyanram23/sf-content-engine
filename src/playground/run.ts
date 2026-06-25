/**
 * Playground CLI — runs the engine end-to-end on the sample fixtures using the deterministic
 * fakes (no network, browser, or API key), demonstrating the three spec §7 acceptance
 * scenarios plus the never-converge guarantee. Writes the frozen screen, poster, and QA
 * report to ./playground-output and prints a summary.
 *
 *   npm run playground
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GenerateOutput } from "../index";
import {
  cleanObservation,
  contrastFailObservation,
  createFakeEngine,
  deadSpaceObservation,
} from "../testing/fakes/index";
import { fixtures } from "../testing/fixtures/index";

interface Scenario {
  name: string;
  description: string;
  run(): Promise<GenerateOutput>;
}

const scenarios: Scenario[] = [
  {
    name: "happy-path",
    description: "Clean render → passes on the first iteration.",
    run: () => createFakeEngine({ observations: [cleanObservation()] }).generate(fixtures.input),
  },
  {
    name: "dead-space-rebalance",
    description: "Acceptance #1 — dead space at the bottom, rebalanced by re-paint within budget.",
    run: () =>
      createFakeEngine({ observations: [deadSpaceObservation(), cleanObservation()] }).generate(
        fixtures.input,
      ),
  },
  {
    name: "contrast-gate",
    description:
      "Acceptance #2 — WCAG contrast hard gate caught, fixed by deterministic token-swap repair.",
    run: () =>
      createFakeEngine({ observations: [contrastFailObservation(), cleanObservation()] }).generate(
        fixtures.input,
      ),
  },
  {
    name: "never-converge",
    description:
      "Critic never passes → ships the best-scoring screen, flagged, within budget (D12).",
    run: () =>
      createFakeEngine({
        observations: [cleanObservation()],
        critiques: [
          {
            findings: [
              {
                dimension: "balance",
                severity: "major",
                tag: "layout",
                region: "whole",
                message: "still off",
              },
            ],
          },
        ],
      }).generate(fixtures.input),
  },
];

async function main(): Promise<void> {
  const outDir = join(process.cwd(), "playground-output");
  mkdirSync(outDir, { recursive: true });

  console.log(
    "content-engine playground — running %d scenarios on the botanical preset\n",
    scenarios.length,
  );
  const reportIndex: Record<string, unknown> = {};

  for (const scenario of scenarios) {
    const output = await scenario.run();
    const report = output.qaReport.screens[0]!;
    const screen = output.screens[0]!;
    const poster = output.posters[0]!;

    writeFileSync(join(outDir, `${scenario.name}.html`), screen.html, "utf8");
    writeFileSync(
      join(outDir, `${scenario.name}.poster.png`),
      Buffer.from(poster.pngBase64, "base64"),
    );
    reportIndex[scenario.name] = { description: scenario.description, report };

    console.log(`▸ ${scenario.name}: ${scenario.description}`);
    console.log(
      `  passed=${report.passed} flagged=${report.flagged} iterations=${report.iterations} ` +
        `route=[${report.routeHistory.join(" → ")}] findings=${report.findings.length}`,
    );
    console.log(
      `  → ${scenario.name}.html (${screen.html.length} bytes), ${scenario.name}.poster.png\n`,
    );
  }

  writeFileSync(join(outDir, "qa-report.json"), JSON.stringify(reportIndex, null, 2), "utf8");
  console.log(`Done. Artifacts written to ${outDir}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
