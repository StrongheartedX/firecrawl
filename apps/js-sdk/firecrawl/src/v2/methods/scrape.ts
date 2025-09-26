import { type Document, type ScrapeOptions } from "../types";
import { HttpClient, calculateTimeout } from "../utils/httpClient";
import { ensureValidScrapeOptions } from "../utils/validation";
import { throwForBadResponse, normalizeAxiosError } from "../utils/errorHandler";

export async function scrape(http: HttpClient, url: string, options?: ScrapeOptions): Promise<Document> {
  if (!url || !url.trim()) {
    throw new Error("URL cannot be empty");
  }
  if (options) ensureValidScrapeOptions(options);

  const payload: Record<string, unknown> = { url: url.trim() };
  if (options) Object.assign(payload, options);

  try {
    const finalTimeout = calculateTimeout(options?.timeout, options?.waitFor, options?.actions);
    const res = await http.post<{ success: boolean; data?: Document; error?: string }>("/v2/scrape", payload, undefined, finalTimeout);
    if (res.status !== 200 || !res.data?.success) {
      throwForBadResponse(res, "scrape");
    }
    return (res.data.data || {}) as Document;
  } catch (err: any) {
    if (err?.isAxiosError) return normalizeAxiosError(err, "scrape");
    throw err;
  }
}

