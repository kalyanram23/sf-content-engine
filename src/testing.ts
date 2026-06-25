/**
 * content-engine/testing — deterministic fakes + fixtures.
 *
 * Lets the consuming service (and this package's own tests/playground) run the engine
 * end-to-end with no network, browser, or API key.
 */

export * from "./testing/fakes/index";
export {
  fixtures,
  sampleMenu,
  samplePlan,
  sampleBrief,
  sampleInput,
} from "./testing/fixtures/index";
