import type { ImageFetcher } from "../../ports/image-fetcher";
import { PLACEHOLDER_IMAGE_DATA_URI } from "../../util/placeholder-image";

/**
 * A deterministic, hermetic image fetcher: maps every URL to a valid 1×1 PNG data-URI (no
 * network). Keeps the default test suite offline while exercising the same data-URI flow the
 * real {@link NodeImageFetcher} produces — so structural/rendered checks see inlined images.
 */
export class FakeImageFetcher implements ImageFetcher {
  fetch(urls: readonly string[]): Promise<Map<string, string>> {
    return Promise.resolve(new Map(urls.map((u) => [u, PLACEHOLDER_IMAGE_DATA_URI])));
  }
}
