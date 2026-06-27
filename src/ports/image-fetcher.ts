/**
 * Resolves remote image references to offline-safe data-URIs (spec §5.1). The pure core only
 * sees this interface; the actual network fetch lives in a Node adapter (S9 hermetic
 * boundary). Item photos are inlined BEFORE paint/QA/package so the whole downstream pipeline
 * — including the network-disabled render — only ever sees `data:` URIs.
 */
export interface ImageFetcher {
  /**
   * Fetch each URL and return a map of `sourceUrl → data-URI`. Implementations should be
   * resilient: a URL that fails to fetch may be omitted from the map (the caller substitutes
   * an offline placeholder), so generation never hard-fails on a flaky photo host.
   */
  fetch(urls: readonly string[]): Promise<Map<string, string>>;
}
