import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  describeIf,
  HAS_AI,
  TEST_PRODUCTION,
} from "../lib";
import { scrape, scrapeTimeout, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "scrape-branding",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(ALLOW_TEST_SUITE_WEBSITE)("Branding extraction", () => {
  describe("Basic branding extraction", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts branding with required fields",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding).toBeDefined();
        expect(response.branding?.colors).toBeDefined();
        expect(response.branding?.typography).toBeDefined();
        expect(response.branding?.spacing).toBeDefined();
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes color palette with valid colors",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.colors).toBeDefined();
        expect(response.branding?.colors?.primary).toBeDefined();
        expect(response.branding?.colors?.accent).toBeDefined();

        // Check that colors are valid hex or rgba format
        const colorRegex = /^(#[A-F0-9]{6}|rgba?\([^)]+\))$/i;
        if (response.branding?.colors?.primary) {
          expect(response.branding.colors.primary).toMatch(colorRegex);
        }
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes typography information",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.typography).toBeDefined();
        expect(response.branding?.typography?.font_families).toBeDefined();
        expect(
          response.branding?.typography?.font_families?.primary,
        ).toBeDefined();
        expect(
          typeof response.branding?.typography?.font_families?.primary,
        ).toBe("string");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes spacing information",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.spacing).toBeDefined();
        expect(response.branding?.spacing?.base_unit).toBeDefined();
        expect(typeof response.branding?.spacing?.base_unit).toBe("number");
        expect(response.branding?.spacing?.base_unit).toBeGreaterThan(0);
        expect(response.branding?.spacing?.base_unit).toBeLessThanOrEqual(128);
      },
      scrapeTimeout,
    );
  });

  describe("Component extraction", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts button components",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.components).toBeDefined();

        // At least primary or secondary button should be present
        const hasPrimary = response.branding?.components?.button_primary;
        const hasSecondary = response.branding?.components?.button_secondary;
        expect(hasPrimary || hasSecondary).toBeTruthy();

        if (hasPrimary) {
          expect(
            response.branding?.components?.button_primary?.background,
          ).toBeDefined();
          expect(
            response.branding?.components?.button_primary?.text_color,
          ).toBeDefined();
          expect(
            response.branding?.components?.button_primary?.border_radius,
          ).toBeDefined();
        }
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts border radius correctly",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        if (response.branding?.components?.button_primary?.border_radius) {
          const radiusMatch =
            response.branding.components.button_primary.border_radius.match(
              /^(\d+(\.\d+)?)(px|rem|em)$/,
            );
          expect(radiusMatch).toBeTruthy();
        }
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "captures hover states when available",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        // Hover states might not always be present, but if they are, they should be valid
        const primaryBtn = response.branding?.components?.button_primary;
        if (primaryBtn?.hover_background) {
          // Should be a valid color format
          expect(
            primaryBtn.hover_background.startsWith("#") ||
              primaryBtn.hover_background.startsWith("rgb") ||
              primaryBtn.hover_background.includes("var("),
          ).toBe(true);
        }
      },
      scrapeTimeout,
    );
  });

  describe("Image extraction", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts logo when present",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.images).toBeDefined();

        // Logo might not always be present, but if it is, should be valid URL or data URL
        if (response.branding?.images?.logo) {
          expect(
            response.branding.images.logo.startsWith("http") ||
              response.branding.images.logo.startsWith("data:"),
          ).toBe(true);
        }
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "extracts favicon when present",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        // Favicon should almost always be present
        if (response.branding?.images?.favicon) {
          expect(
            response.branding.images.favicon.startsWith("http") ||
              response.branding.images.favicon.startsWith("data:"),
          ).toBe(true);
        }
      },
      scrapeTimeout,
    );
  });

  describe("LLM enhancement", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes LLM-enhanced fields",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        // LLM-enhanced fields should be present
        expect(response.branding?.personality).toBeDefined();
        expect(response.branding?.design_system).toBeDefined();
        expect(response.branding?.confidence).toBeDefined();

        if (response.branding?.confidence) {
          expect(response.branding.confidence).toBeGreaterThanOrEqual(0);
          expect(response.branding.confidence).toBeLessThanOrEqual(1);
        }
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "includes cleaned fonts from LLM",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        expect(response.branding?.fonts).toBeDefined();
        expect(Array.isArray(response.branding?.fonts)).toBe(true);

        // Check that fonts have expected structure if present
        if (response.branding?.fonts && response.branding.fonts.length > 0) {
          const font = response.branding.fonts[0];
          expect(font.family).toBeDefined();
          expect(typeof font.family).toBe("string");

          // Font should not have Next.js obfuscation patterns
          expect(font.family).not.toMatch(/__\w+_[a-f0-9]{8}/i);
        }
      },
      scrapeTimeout,
    );
  });

  describe("Color scheme detection", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "detects color scheme",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        // Color scheme should be detected
        if (response.branding?.color_scheme) {
          expect(["light", "dark"]).toContain(response.branding.color_scheme);
        }
      },
      scrapeTimeout,
    );
  });

  describe("Multiple formats compatibility", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "works alongside other formats",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["markdown", "branding"],
          },
          identity,
        );

        expect(response.markdown).toBeDefined();
        expect(response.branding).toBeDefined();
        expect(typeof response.markdown).toBe("string");
        expect(typeof response.branding).toBe("object");
      },
      scrapeTimeout,
    );

    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "does not interfere with screenshot",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding", "screenshot"],
          },
          identity,
        );

        expect(response.branding).toBeDefined();
        expect(response.screenshot).toBeDefined();
        expect(typeof response.screenshot).toBe("string");
      },
      scrapeTimeout,
    );
  });

  describe("SVG logo handling", () => {
    concurrentIf(TEST_PRODUCTION || HAS_AI)(
      "converts SVG elements to data URLs",
      async () => {
        const response = await scrape(
          {
            url: "https://firecrawl.dev",
            formats: ["branding"],
          },
          identity,
        );

        if (response.branding?.images?.logo?.startsWith("data:image/svg")) {
          // Should be a valid SVG data URL
          expect(response.branding.images.logo).toContain("svg");
          expect(
            response.branding.images.logo.startsWith("data:image/svg+xml"),
          ).toBe(true);
        }
      },
      scrapeTimeout,
    );
  });
});
