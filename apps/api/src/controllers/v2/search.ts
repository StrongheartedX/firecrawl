import { Response } from "express";
import { config } from "../../config";
import {
  Document,
  RequestWithAuth,
  SearchRequest,
  SearchResponse,
  searchRequestSchema,
  ScrapeOptions,
  TeamFlags,
} from "./types";
import { billTeam } from "../../services/billing/credit_billing";
import { v7 as uuidv7 } from "uuid";
import { logSearch, logRequest } from "../../services/logging/log_job";
import { search } from "../../search/v2";
import { isUrlBlocked } from "../../scraper/WebScraper/utils/blocklist";
import { logger as _logger } from "../../lib/logger";
import type { Logger } from "winston";
import { getJobPriority } from "../../lib/job-priority";
import { CostTracking } from "../../lib/cost-tracking";
import { SearchV2Response } from "../../lib/entities";
import { ScrapeJobTimeoutError } from "../../lib/error";
import { z } from "zod";
import {
  buildSearchQuery,
  getCategoryFromUrl,
  CategoryOption,
} from "../../lib/search-query-builder";
import {
  applyZdrScope,
  captureExceptionWithZdrCheck,
} from "../../services/sentry";
import { NuQJob } from "../../services/worker/nuq";
import { processJobInternal } from "../../services/worker/scrape-worker";
import { ScrapeJobData } from "../../types";

interface DocumentWithCostTracking {
  document: Document;
  costTracking: ReturnType<typeof CostTracking.prototype.toJSON>;
}

interface ScrapeJobInput {
  url: string;
  title: string;
  description: string;
}

/**
 * Directly scrape a search result without going through NuQ queue.
 * This bypasses concurrency limits and calls processJobInternal directly.
 * All search scrapes run concurrently via Promise.all().
 */
async function scrapeSearchResultDirect(
  searchResult: { url: string; title: string; description: string },
  options: {
    teamId: string;
    origin: string;
    timeout: number;
    scrapeOptions: ScrapeOptions;
    bypassBilling?: boolean;
    apiKeyId: number | null;
    zeroDataRetention?: boolean;
    requestId?: string;
  },
  logger: Logger,
  flags: TeamFlags,
  jobPriority: number,
): Promise<DocumentWithCostTracking> {
  const jobId = uuidv7();

  const zeroDataRetention =
    flags?.forceZDR || (options.zeroDataRetention ?? false);

  logger.debug("Starting direct scrape for search result", {
    scrapeId: jobId,
    url: searchResult.url,
    teamId: options.teamId,
    origin: options.origin,
    zeroDataRetention,
  });

  try {
    const job: NuQJob<ScrapeJobData> = {
      id: jobId,
      status: "active",
      createdAt: new Date(),
      priority: jobPriority,
      data: {
        url: searchResult.url,
        mode: "single_urls",
        team_id: options.teamId,
        scrapeOptions: {
          ...options.scrapeOptions,
          maxAge: 3 * 24 * 60 * 60 * 1000, // 3 days
        },
        internalOptions: {
          teamId: options.teamId,
          bypassBilling: options.bypassBilling ?? true,
          zeroDataRetention,
          teamFlags: flags,
        },
        skipNuq: true, // Skip NuQ queue
        origin: options.origin,
        is_scrape: false, // Search scrapes don't count as direct scrapes
        startTime: Date.now(),
        zeroDataRetention,
        apiKeyId: options.apiKeyId,
        requestId: options.requestId,
      },
    };

    // Directly call processJobInternal without going through queue
    const doc = await processJobInternal(job);

    logger.info("Direct scrape completed for search result", {
      scrapeId: jobId,
      url: searchResult.url,
      teamId: options.teamId,
      origin: options.origin,
    });

    const document: Document = {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      ...doc,
      metadata: doc?.metadata ?? {
        statusCode: 200,
        proxyUsed: "basic",
      },
    };

    // Cost tracking is handled internally by processJobInternal
    const costTracking = new CostTracking().toJSON();

    return {
      document,
      costTracking,
    };
  } catch (error) {
    logger.error(`Error in scrapeSearchResultDirect: ${error}`, {
      url: searchResult.url,
      teamId: options.teamId,
      scrapeId: jobId,
    });

    const document: Document = {
      title: searchResult.title,
      description: searchResult.description,
      url: searchResult.url,
      metadata: {
        statusCode: 500,
        error: error.message,
        proxyUsed: "basic",
      },
    };

    return {
      document,
      costTracking: new CostTracking().toJSON(),
    };
  }
}

export async function searchController(
  req: RequestWithAuth<{}, SearchResponse, SearchRequest>,
  res: Response<SearchResponse>,
) {
  // Get timing data from middleware (includes all middleware processing time)
  const middlewareStartTime =
    (req as any).requestTiming?.startTime || new Date().getTime();
  const controllerStartTime = new Date().getTime();

  const jobId = uuidv7();
  let logger = _logger.child({
    jobId,
    teamId: req.auth.team_id,
    module: "api/v2",
    method: "searchController",
    zeroDataRetention: req.acuc?.flags?.forceZDR,
  });

  if (req.acuc?.flags?.forceZDR) {
    return res.status(400).json({
      success: false,
      error:
        "Your team has zero data retention enabled. This is not supported on search. Please contact support@firecrawl.com to unblock this feature.",
    });
  }

  const middlewareTime = controllerStartTime - middlewareStartTime;
  const isSearchPreview =
    config.SEARCH_PREVIEW_TOKEN !== undefined &&
    config.SEARCH_PREVIEW_TOKEN === req.body.__searchPreviewToken;

  let credits_billed = 0;

  let zeroDataRetention = false;

  try {
    req.body = searchRequestSchema.parse(req.body);

    if (
      req.body.__agentInterop &&
      config.AGENT_INTEROP_SECRET &&
      req.body.__agentInterop.auth !== config.AGENT_INTEROP_SECRET
    ) {
      return res.status(403).json({
        success: false,
        error: "Invalid agent interop.",
      });
    } else if (req.body.__agentInterop && !config.AGENT_INTEROP_SECRET) {
      return res.status(403).json({
        success: false,
        error: "Agent interop is not enabled.",
      });
    }

    const shouldBill = req.body.__agentInterop?.shouldBill ?? true;
    const agentRequestId = req.body.__agentInterop?.requestId ?? null;

    logger = logger.child({
      version: "v2",
      query: req.body.query,
      origin: req.body.origin,
    });

    const isZDR = req.body.enterprise?.includes("zdr");
    const isAnon = req.body.enterprise?.includes("anon");
    const isZDROrAnon = isZDR || isAnon;
    zeroDataRetention = isZDROrAnon ?? false;
    applyZdrScope(isZDROrAnon ?? false);

    if (!agentRequestId) {
      await logRequest({
        id: jobId,
        kind: "search",
        api_version: "v2",
        team_id: req.auth.team_id,
        origin: req.body.origin ?? "api",
        integration: req.body.integration,
        target_hint: req.body.query,
        zeroDataRetention: isZDROrAnon ?? false, // not supported for search
        api_key_id: req.acuc?.api_key_id ?? null,
      });
    }

    let limit = req.body.limit;

    // Buffer results by 50% to account for filtered URLs
    const num_results_buffer = Math.floor(limit * 2);

    logger.info("Searching for results");

    // Extract unique types from sources for the search function
    // After transformation, sources is always an array of objects
    const searchTypes = [...new Set(req.body.sources.map((s: any) => s.type))];

    // Build search query with category filters
    const { query: searchQuery, categoryMap } = buildSearchQuery(
      req.body.query,
      req.body.categories as CategoryOption[],
    );

    const searchResponse = (await search({
      query: searchQuery,
      logger,
      advanced: false,
      num_results: num_results_buffer,
      tbs: req.body.tbs,
      filter: req.body.filter,
      lang: req.body.lang,
      country: req.body.country,
      location: req.body.location,
      type: searchTypes,
      enterprise: req.body.enterprise,
    })) as SearchV2Response;

    // Add category labels to web results
    if (searchResponse.web && searchResponse.web.length > 0) {
      searchResponse.web = searchResponse.web.map(result => ({
        ...result,
        category: getCategoryFromUrl(result.url, categoryMap),
      }));
    }

    // Add category labels to news results
    if (searchResponse.news && searchResponse.news.length > 0) {
      searchResponse.news = searchResponse.news.map(result => ({
        ...result,
        category: result.url
          ? getCategoryFromUrl(result.url, categoryMap)
          : undefined,
      }));
    }

    // Apply limit to each result type separately
    let totalResultsCount = 0;

    // Apply limit to web results
    if (searchResponse.web && searchResponse.web.length > 0) {
      if (searchResponse.web.length > limit) {
        searchResponse.web = searchResponse.web.slice(0, limit);
      }
      totalResultsCount += searchResponse.web.length;
    }

    // Apply limit to images
    if (searchResponse.images && searchResponse.images.length > 0) {
      if (searchResponse.images.length > limit) {
        searchResponse.images = searchResponse.images.slice(0, limit);
      }
      totalResultsCount += searchResponse.images.length;
    }

    // Apply limit to news
    if (searchResponse.news && searchResponse.news.length > 0) {
      if (searchResponse.news.length > limit) {
        searchResponse.news = searchResponse.news.slice(0, limit);
      }
      totalResultsCount += searchResponse.news.length;
    }

    // Check if scraping is requested
    const shouldScrape =
      req.body.scrapeOptions?.formats &&
      req.body.scrapeOptions.formats.length > 0;

    if (!shouldScrape) {
      const creditsPerTenResults = isZDR ? 10 : 2;
      credits_billed = Math.ceil(totalResultsCount / 10) * creditsPerTenResults;
    } else {
      // Direct scraping (calls processJobInternal directly, no NuQ, no concurrency limits)
      logger.info("Starting direct search scraping");

      // Safely extract scrapeOptions with runtime check
      if (!req.body.scrapeOptions) {
        logger.error(
          "scrapeOptions is undefined despite shouldScrape being true",
        );
        return res.status(500).json({
          success: false,
          error: "Internal server error: scrapeOptions is missing",
        });
      }

      const bodyScrapeOptions = req.body.scrapeOptions;

      // Create common options
      const scrapeOptions = {
        teamId: req.auth.team_id,
        origin: req.body.origin,
        timeout: req.body.timeout,
        scrapeOptions: bodyScrapeOptions,
        bypassBilling: !shouldBill, // Scrape jobs always bill themselves
        apiKeyId: req.acuc?.api_key_id ?? null,
        zeroDataRetention: isZDROrAnon,
        requestId: agentRequestId ?? jobId,
      };

      // Prepare all items to scrape with their original data
      const itemsToScrape: Array<{
        item: any;
        type: "web" | "news" | "image";
        scrapeInput: ScrapeJobInput;
      }> = [];

      // Add web results (skip blocked URLs)
      if (searchResponse.web) {
        searchResponse.web.forEach(item => {
          if (!isUrlBlocked(item.url, req.acuc?.flags ?? null)) {
            itemsToScrape.push({
              item,
              type: "web",
              scrapeInput: {
                url: item.url,
                title: item.title,
                description: item.description,
              },
            });
          } else {
            logger.info(`Skipping blocked URL: ${item.url}`);
          }
        });
      }

      // Add news results (only those with URLs and not blocked)
      if (searchResponse.news) {
        searchResponse.news
          .filter(item => item.url)
          .forEach(item => {
            if (!isUrlBlocked(item.url!, req.acuc?.flags ?? null)) {
              itemsToScrape.push({
                item,
                type: "news",
                scrapeInput: {
                  url: item.url!,
                  title: item.title || "",
                  description: item.snippet || "",
                },
              });
            } else {
              logger.info(`Skipping blocked URL: ${item.url}`);
            }
          });
      }

      // Add image results (only those with URLs and not blocked)
      if (searchResponse.images) {
        searchResponse.images
          .filter(item => item.url)
          .forEach(item => {
            if (!isUrlBlocked(item.url!, req.acuc?.flags ?? null)) {
              itemsToScrape.push({
                item,
                type: "image",
                scrapeInput: {
                  url: item.url!,
                  title: item.title || "",
                  description: "",
                },
              });
            } else {
              logger.info(`Skipping blocked URL: ${item.url}`);
            }
          });
      }

      // Get job priority once for all scrapes
      const jobPriority = await getJobPriority({
        team_id: req.auth.team_id,
        basePriority: 10,
      });

      // Call processJobInternal directly for all search scrapes (no NuQ, no concurrency limits)
      // All scrapes are started concurrently via Promise.all()
      logger.info(
        `Starting ${itemsToScrape.length} concurrent scrapes for search results`,
      );

      const allPromises = itemsToScrape.map(({ scrapeInput }) =>
        scrapeSearchResultDirect(
          scrapeInput,
          scrapeOptions,
          logger,
          req.acuc?.flags ?? null,
          jobPriority,
        ),
      );

      // Execute all scrapes concurrently
      const allDocsWithCostTracking = await Promise.all(allPromises);

      logger.info(
        `Completed ${allDocsWithCostTracking.length} concurrent scrapes for search results`,
      );

      const scrapedResponse: SearchV2Response = {};

      // Create a map of results indexed by URL for easy lookup
      const resultsMap = new Map<string, Document>();
      itemsToScrape.forEach((item, index) => {
        resultsMap.set(
          item.scrapeInput.url,
          allDocsWithCostTracking[index].document,
        );
      });

      // Process web results - preserve all original fields and add scraped content
      if (searchResponse.web && searchResponse.web.length > 0) {
        scrapedResponse.web = searchResponse.web.map(item => {
          const doc = resultsMap.get(item.url);
          return {
            ...item, // Preserve ALL original fields
            ...doc, // Override/add scraped content
          };
        });
      }

      // Process news results - preserve all original fields and add scraped content
      if (searchResponse.news && searchResponse.news.length > 0) {
        scrapedResponse.news = searchResponse.news.map(item => {
          const doc = item.url ? resultsMap.get(item.url) : undefined;
          return {
            ...item, // Preserve ALL original fields
            ...doc, // Override/add scraped content
          };
        });
      }

      // Process image results - preserve all original fields and add scraped content
      if (searchResponse.images && searchResponse.images.length > 0) {
        scrapedResponse.images = searchResponse.images.map(item => {
          const doc = item.url ? resultsMap.get(item.url) : undefined;
          return {
            ...item, // Preserve ALL original fields
            ...doc, // Override/add scraped content
          };
        });
      }

      // Calculate search credits only - scrape jobs bill themselves
      const creditsPerTenResults = isZDR ? 10 : 2;
      credits_billed = Math.ceil(totalResultsCount / 10) * creditsPerTenResults;

      // Update response with scraped data
      Object.assign(searchResponse, scrapedResponse);
    }

    // Bill team for search credits only
    // - Scrape jobs always handle their own billing
    // - Search job only bills for search costs (credits per 10 results)
    if (!isSearchPreview) {
      billTeam(
        req.auth.team_id,
        req.acuc?.sub_id ?? undefined,
        credits_billed,
        req.acuc?.api_key_id ?? null,
      ).catch(error => {
        logger.error(
          `Failed to bill team ${req.acuc?.sub_id} for ${credits_billed} credits: ${error}`,
        );
      });
    }

    const endTime = new Date().getTime();
    const timeTakenInSeconds = (endTime - middlewareStartTime) / 1000;

    logger.info("Logging job", {
      num_docs: credits_billed,
      time_taken: timeTakenInSeconds,
    });

    logSearch(
      {
        id: jobId,
        request_id: agentRequestId ?? jobId,
        query: req.body.query,
        is_successful: true,
        error: undefined,
        results: searchResponse as any,
        num_results: totalResultsCount,
        time_taken: timeTakenInSeconds,
        team_id: req.auth.team_id,
        options: req.body,
        credits_cost: shouldBill ? credits_billed : 0,
        zeroDataRetention: isZDROrAnon ?? false, // not supported
      },
      false,
    );

    // Log final timing information
    const totalRequestTime = new Date().getTime() - middlewareStartTime;
    const controllerTime = new Date().getTime() - controllerStartTime;

    logger.info("Request metrics", {
      version: "v2",
      jobId,
      mode: "search",
      middlewareStartTime,
      controllerStartTime,
      middlewareTime,
      controllerTime,
      totalRequestTime,
      creditsUsed: credits_billed,
      scrapeful: shouldScrape,
    });

    // For sync scraping or no scraping, don't include scrapeIds
    return res.status(200).json({
      success: true,
      data: searchResponse,
      creditsUsed: credits_billed,
      id: jobId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.warn("Invalid request body", { error: error.issues });
      return res.status(400).json({
        success: false,
        error: "Invalid request body",
        details: error.issues,
      });
    }

    if (error instanceof ScrapeJobTimeoutError) {
      return res.status(408).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }

    captureExceptionWithZdrCheck(error, {
      extra: { zeroDataRetention },
    });
    logger.error("Unhandled error occurred in search", {
      version: "v2",
      error,
    });
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}
