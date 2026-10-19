const { Readability } = require("@mozilla/readability");
const { parseHTML } = require("linkedom");
const TurndownService = require("turndown");

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});

// Remove elements that are pure noise (ads, iframes, nav, footers, cookie banners)
turndown.remove(["script", "style", "noscript", "iframe", "svg", "canvas"]);

/**
 * Convert an HTML string to clean Markdown using Mozilla Readability for
 * main-content extraction and Turndown for HTML→Markdown conversion.
 *
 * Falls back to a full-page Turndown conversion if Readability cannot
 * identify a main article (e.g. tool pages, docs sites with no <article>).
 *
 * @param {string} html - The raw HTML string
 * @returns {{ markdown: string, title: string|null, source: "readability"|"raw" }}
 */
function toMarkdown(html) {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();

    if (article && article.content) {
      const markdown = turndown.turndown(article.content).trim();
      if (markdown.length > 0) {
        return {
          markdown,
          title: article.title || null,
          textContent: article.textContent || "",
          source: "readability",
        };
      }
    }

    // Fallback: convert the full page
    const markdown = turndown.turndown(document.body ? document.body.innerHTML : html).trim();
    return {
      markdown,
      title: document.title || null,
      textContent: document.body ? document.body.textContent : html,
      source: "raw",
    };
  } catch (err) {
    console.error("[toMarkdown] Conversion failed:", err.message);
    return { markdown: "", title: null, textContent: "", source: "error" };
  }
}

module.exports = { toMarkdown };
