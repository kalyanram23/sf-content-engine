import type { ImageFetcher } from "../../ports/image-fetcher";
import { PLACEHOLDER_IMAGE_DATA_URI } from "../../util/placeholder-image";

export interface FakeImageFetcherOptions {
  /** URLs that simulate a FAILED fetch: omitted from the result map (the node drops the ref). */
  failUrls?: readonly string[];
  /** The data-URI successful fetches resolve to (default: the 1×1 placeholder PNG). Set a
   * distinctive URI when a test must tell a real inlined photo apart from the placeholder. */
  dataUri?: string;
}

/**
 * A deterministic, hermetic image fetcher: maps every URL to a valid data-URI (no network) —
 * except `failUrls`, which are omitted from the map exactly like the real `NodeImageFetcher`
 * omits a URL that failed to fetch. Keeps the default test suite offline while exercising the
 * same data-URI flow the real adapter produces — so structural/rendered checks see inlined images.
 */
export class FakeImageFetcher implements ImageFetcher {
  private readonly failing: ReadonlySet<string>;
  private readonly dataUri: string;

  constructor(options: FakeImageFetcherOptions = {}) {
    this.failing = new Set(options.failUrls ?? []);
    this.dataUri = options.dataUri ?? PLACEHOLDER_IMAGE_DATA_URI;
  }

  fetch(urls: readonly string[]): Promise<Map<string, string>> {
    return Promise.resolve(
      new Map(urls.filter((u) => !this.failing.has(u)).map((u) => [u, this.dataUri])),
    );
  }
}
