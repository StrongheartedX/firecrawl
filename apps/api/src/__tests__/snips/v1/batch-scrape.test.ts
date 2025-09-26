import { batchScrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "batch-scrape",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("Batch scrape tests", () => {
  it.concurrent(
    "works",
    async () => {
      const response = await batchScrape(
        {
          urls: ["http://firecrawl.dev"],
        },
        identity,
      );

      expect(response.data[0]).toHaveProperty("markdown");
      expect(response.data[0].markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  if (!process.env.TEST_SUITE_SELF_HOSTED) {
    describe("JSON format", () => {
      it.concurrent(
        "works",
        async () => {
          const response = await batchScrape(
            {
              urls: ["http://firecrawl.dev"],
              formats: ["json"],
              jsonOptions: {
                prompt:
                  "Based on the information on the page, find what the company's mission is and whether it supports SSO, and whether it is open source.",
                schema: {
                  type: "object",
                  properties: {
                    company_mission: {
                      type: "string",
                    },
                    supports_sso: {
                      type: "boolean",
                    },
                    is_open_source: {
                      type: "boolean",
                    },
                  },
                  required: [
                    "company_mission",
                    "supports_sso",
                    "is_open_source",
                  ],
                },
              },
            },
            identity,
          );

          expect(response.data[0]).toHaveProperty("json");
          expect(response.data[0].json).toHaveProperty("company_mission");
          expect(typeof response.data[0].json.company_mission).toBe("string");
          expect(response.data[0].json).toHaveProperty("supports_sso");
          expect(response.data[0].json.supports_sso).toBe(false);
          expect(typeof response.data[0].json.supports_sso).toBe("boolean");
          expect(response.data[0].json).toHaveProperty("is_open_source");
          expect(response.data[0].json.is_open_source).toBe(true);
          expect(typeof response.data[0].json.is_open_source).toBe("boolean");
        },
        180000,
      );
    });
  }

  it.concurrent(
    "sourceURL stays unnormalized",
    async () => {
      const response = await batchScrape(
        {
          urls: ["https://firecrawl.dev/?pagewanted=all&et_blog"],
        },
        identity,
      );

      expect(response.data[0].metadata.sourceURL).toBe(
        "https://firecrawl.dev/?pagewanted=all&et_blog",
      );
    },
    scrapeTimeout,
  );

  describe("DELETE /v1/batch/scrape/{id}", () => {
    it.concurrent(
      "should return 409 when trying to cancel a completed batch scrape job",
      async () => {
        const response = await batchScrape(
          {
            urls: ["https://example.com"],
          },
          identity,
        );

        expect(response.success).toBe(true);
        if (response.success) {
          const batchId = response.id;

          const cancelResponse = await fetch(
            `${process.env.TEST_API_URL}/v1/batch/scrape/${batchId}`,
            {
              method: "DELETE",
              headers: {
                Authorization: `Bearer ${identity.apiKey}`,
                "Content-Type": "application/json",
              },
            },
          );

          expect(cancelResponse.status).toBe(409);
          const cancelData = await cancelResponse.json();
          expect(cancelData.error).toBe(
            "Cannot cancel job that has already completed",
          );
        }
      },
      scrapeTimeout,
    );

    it.concurrent(
      "should successfully cancel an in-progress batch scrape job",
      async () => {
        const startResponse = await fetch(
          `${process.env.TEST_API_URL}/v1/batch/scrape`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${identity.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              urls: Array.from(
                { length: 10 },
                (_, i) => `https://firecrawl.dev/page-${i}`,
              ),
            }),
          },
        );

        expect(startResponse.status).toBe(200);
        const startData = await startResponse.json();
        const batchId = startData.id;

        let attempts = 0;
        let statusResponse;
        do {
          await new Promise(resolve => setTimeout(resolve, 500));
          statusResponse = await fetch(
            `${process.env.TEST_API_URL}/v1/batch/scrape/${batchId}`,
            {
              headers: {
                Authorization: `Bearer ${identity.apiKey}`,
              },
            },
          );
          const statusData = await statusResponse.json();
          attempts++;
          if (statusData.status === "scraping" || attempts >= 10) break;
        } while (attempts < 10);

        const cancelResponse = await fetch(
          `${process.env.TEST_API_URL}/v1/batch/scrape/${batchId}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${identity.apiKey}`,
              "Content-Type": "application/json",
            },
          },
        );

        expect(cancelResponse.status).toBe(200);
        const cancelData = await cancelResponse.json();
        expect(cancelData.success).toBe(true);
        expect(cancelData.message).toContain("cancelled");
      },
      scrapeTimeout,
    );
  });
});
