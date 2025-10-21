import { parseMarkdown } from "../html-to-markdown";

describe("parseMarkdown", () => {
  it("should correctly convert simple HTML to Markdown", async () => {
    const html = "<p>Hello, world!</p>";
    const expectedMarkdown = "Hello, world!";
    await expect(parseMarkdown(html)).resolves.toBe(expectedMarkdown);
  });

  it("should convert complex HTML with nested elements to Markdown", async () => {
    const html =
      "<div><p>Hello <strong>bold</strong> world!</p><ul><li>List item</li></ul></div>";
    const expectedMarkdown = "Hello **bold** world!\n\n*   List item";
    await expect(parseMarkdown(html)).resolves.toBe(expectedMarkdown);
  });

  it("should return empty string when input is empty", async () => {
    const html = "";
    const expectedMarkdown = "";
    await expect(parseMarkdown(html)).resolves.toBe(expectedMarkdown);
  });

  it("should handle null input gracefully", async () => {
    const html = null;
    const expectedMarkdown = "";
    await expect(parseMarkdown(html)).resolves.toBe(expectedMarkdown);
  });

  it("should handle various types of invalid HTML gracefully", async () => {
    const invalidHtmls = [
      { html: "<html><p>Unclosed tag", expected: "Unclosed tag" },
      {
        html: "<div><span>Missing closing div",
        expected: "Missing closing div",
      },
      {
        html: "<p><strong>Wrong nesting</em></strong></p>",
        expected: "**Wrong nesting**",
      },
      {
        html: '<a href="http://example.com">Link without closing tag',
        expected: "[Link without closing tag](http://example.com)",
      },
    ];

    for (const { html, expected } of invalidHtmls) {
      await expect(parseMarkdown(html)).resolves.toBe(expected);
    }
  });

  it("should extract code from complex code blocks with table structure", async () => {
    const html = `
      <pre class="code-block-root not-prose" tabindex="0">
        <div dir="ltr" class="fern-scroll-area">
          <div data-radix-scroll-area-viewport="" class="fern-scroll-area-viewport">
            <div style="min-width:100%;display:table">
              <code class="code-block text-sm">
                <div class="code-block-inner">
                  <table class="code-block-line-group">
                    <colgroup><col class="w-fit"><col></colgroup>
                    <tbody>
                      <tr class="code-block-line">
                        <td class="code-block-line-gutter"><span>1</span></td>
                        <td class="code-block-line-content">
                          <span class="line">
                            <span>env.YOUR_VARIABLE_NAME</span>
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </code>
            </div>
          </div>
        </div>
      </pre>
    `;
    const result = await parseMarkdown(html);
    expect(result).toContain("env.YOUR_VARIABLE_NAME");
    expect(result.trim()).not.toBe("");
  });

  it("should extract multi-line code from complex code blocks", async () => {
    const html = `
      <pre class="code-block-root not-prose">
        <code class="code-block text-sm">
          <div class="code-block-inner">
            <table class="code-block-line-group">
              <tbody>
                <tr class="code-block-line">
                  <td class="code-block-line-gutter"><span>1</span></td>
                  <td class="code-block-line-content"><span class="line"><span>client&lt;llm&gt; MyCustomClient {</span></span></td>
                </tr>
                <tr class="code-block-line">
                  <td class="code-block-line-gutter"><span>2</span></td>
                  <td class="code-block-line-content"><span class="line"><span>  provider "openai"</span></span></td>
                </tr>
                <tr class="code-block-line">
                  <td class="code-block-line-gutter"><span>3</span></td>
                  <td class="code-block-line-content"><span class="line"><span>  api_key env.MY_API_KEY</span></span></td>
                </tr>
                <tr class="code-block-line">
                  <td class="code-block-line-gutter"><span>4</span></td>
                  <td class="code-block-line-content"><span class="line"><span>}</span></span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </code>
      </pre>
    `;
    const result = await parseMarkdown(html);
    expect(result).toContain("client<llm> MyCustomClient");
    expect(result).toContain('provider "openai"');
    expect(result).toContain("api_key env.MY_API_KEY");
  });
});
