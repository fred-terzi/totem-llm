/**
 * Execute a web scraping flow step
 * @param {Object} config Flow step configuration
 * @param {Object} context Execution context with introspect function
 * @returns {Promise<string>} Scraped content
 */
async function executeWebScraping(config, context) {
  const { CollectorApi } = require("../../collectorApi");
  const { TokenManager } = require("../../helpers/tiktoken");

  const { url, captureAs = "markdown" } = config;
  const { introspect, logger, aibitat } = context;
  logger(
    `\x1b[43m[AgentFlowToolExecutor]\x1b[0m - executing Web Scraping block`
  );

  if (!url) {
    throw new Error("URL is required for web scraping");
  }

  const captureMode = captureAs === "querySelector" ? "html" : captureAs;
  introspect(`Scraping the content of ${url} as ${captureAs}`);
  const { success, content } = await new CollectorApi()
    .getLinkContent(url, captureMode)
    .then((res) => {
      if (captureAs !== "querySelector") return res;
      return parseHTMLwithSelector(res.content, config.querySelector, context);
    });

  if (!success) {
    introspect(`Could not scrape ${url}. Cannot use this page's content.`);
    throw new Error("URL could not be scraped and no content was found.");
  }

  introspect(`Successfully scraped content from ${url}`);
  if (!content || content?.length === 0) {
    introspect("There was no content to be collected or read.");
    throw new Error("There was no content to be collected or read.");
  }

  // Truncate oversized pages instead of summarizing - summarization costs
  // extra LLM calls/credits and can be slow. Token-accurate slice keeps valid UTF-8.
  const DEFAULT_MAX_TOKENS = 32_000;
  const cap = Math.max(
    500,
    Math.min(config.maxTokens || DEFAULT_MAX_TOKENS, 128_000)
  );
  const tokenManager = new TokenManager(aibitat.defaultProvider.model);
  const tokens = tokenManager.tokensFromString(content);

  if (tokens.length <= cap) {
    logger(
      `Content within cap (${tokens.length}/${cap} tokens). Returning full content.`
    );
    return content;
  }

  introspect(
    `This page's content is ~${tokens.length} tokens, exceeding the ${cap} token cap. Truncating to fit.`
  );
  const truncated = tokenManager.bytesFromTokens(tokens.slice(0, cap));
  logger(
    `Truncated content from ${tokens.length} to ${cap} tokens (no summarization to save credits).`
  );
  return `${truncated}\n\n[Content truncated: page was ~${tokens.length} tokens, showing first ${cap} tokens.]`;
}

/**
 * Parse HTML with a CSS selector
 * @param {string} html - The HTML to parse
 * @param {string|null} selector - The CSS selector to use (as text string)
 * @param {{introspect: Function}} context - The context object
 * @returns {Object} The parsed content
 */
function parseHTMLwithSelector(html, selector = null, context) {
  if (!selector || selector.length === 0) {
    context.introspect("No selector provided. Returning the entire HTML.");
    return { success: true, content: html };
  }

  const Cheerio = require("cheerio");
  const $ = Cheerio.load(html);
  const selectedElements = $(selector);

  let content;
  if (selectedElements.length === 0) {
    return { success: false, content: null };
  } else if (selectedElements.length === 1) {
    content = selectedElements.html();
  } else {
    context.introspect(
      `Found ${selectedElements.length} elements matching selector: ${selector}`
    );
    content = selectedElements
      .map((_, element) => $(element).html())
      .get()
      .join("\n");
  }
  return { success: true, content };
}

module.exports = executeWebScraping;
