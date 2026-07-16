import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  highlightMarkdownSource,
  renderMarkdownToHtml,
} from "./markdown-render";

describe("markdown-render", () => {
  it("escapes raw HTML in content", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(renderMarkdownToHtml("Hello <b>x</b>")).not.toMatch(/<b>/);
    expect(renderMarkdownToHtml("Hello <b>x</b>")).toMatch(/&lt;b&gt;/);
  });

  it("renders headings, lists, and fenced code", () => {
    const html = renderMarkdownToHtml(
      ["# Title", "", "- one", "- two", "", "```ts", "const x = 1", "```"].join(
        "\n",
      ),
    );
    expect(html).toMatch(/<h1>/);
    expect(html).toMatch(/<ul>/);
    expect(html).toMatch(/md-fence/);
    expect(html).toMatch(/const x = 1/);
  });

  it("highlights markdown source tokens", () => {
    const hi = highlightMarkdownSource(
      "## Role\n\nUse **bold** and `code`\n- item\nMUST NOT ship",
    );
    expect(hi).toMatch(/md-tok-heading/);
    expect(hi).toMatch(/md-tok-bold/);
    expect(hi).toMatch(/md-tok-inline-code/);
    expect(hi).toMatch(/md-tok-list/);
    expect(hi).toMatch(/md-tok-keyword/);
  });

  it("rejects script markup, unsafe URLs, malformed fences, and attributes", () => {
    const html = renderMarkdownToHtml(
      [
        '<script src="https://evil.invalid/x.js">alert(1)</script>',
        "[click](javascript:alert(1))",
        '```ts" onmouseover="alert(1)',
        '<img src=x onerror="alert(1)">',
      ].join("\n"),
    );
    expect(html).not.toMatch(
      /<script|<img|href="javascript:|<[^>]+on(?:mouseover|error)=/i,
    );
    expect(html).toMatch(/&lt;script/);
    expect(html).toContain("javascript:alert(1)");
  });
});
