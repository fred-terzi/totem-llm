const { CollectorApi } = require("../../../collectorApi");

const webScraping = {
  name: "web-scraping",
  startupConfig: {
    params: {},
  },
  plugin: function () {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          controller: new AbortController(),
          description:
            "Read and extract content from a specific webpage URL. Fetch the text from a website, get the contents of a link, or visit a URL to see what it says. Use when you have a specific web address to read.",
          examples: [
            {
              prompt: "Read that URL for me",
              call: JSON.stringify({ url: "https://example.com" }),
            },
            {
              prompt: "What is anythingllm.com about?",
              call: JSON.stringify({ url: "https://anythingllm.com" }),
            },
            {
              prompt: "Scrape https://example.com",
              call: JSON.stringify({ url: "https://example.com" }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              url: {
                type: "string",
                format: "uri",
                description:
                  "A complete web address URL including protocol. Assumes https if not provided.",
              },
              maxTokens: {
                type: "number",
                minimum: 500,
                maximum: 128000,
                description:
                  "Optional. Maximum number of tokens of page content to include. If the page exceeds this, it will be truncated to fit (the beginning of the page is kept, the rest is cut). Default is 32000. Use a lower value (e.g. 5000-10000) when you only need a quick overview, or higher (up to 128000) when you need more detail.",
              },
            },
            additionalProperties: false,
          },
          handler: async function ({ url, maxTokens }) {
            try {
              if (url) return await this.scrape(url, maxTokens);
              return "There is nothing we can do. This function call returns no information.";
            } catch (error) {
              const errorMessage = error?.message ?? JSON.stringify(error);
              this.super.handlerProps.log(
                `Web Scraping Error: ${errorMessage}`
              );
              this.super.introspect(
                `${this.caller}: Web Scraping Error: ${errorMessage}`
              );
              return `There was an error while calling the function. No data or response was found. Let the user know this was the error: ${errorMessage}`;
            }
          },

          /**
           * Report a URL citation to be displayed in the chat UI.
           * @param {string} url - The URL that was accessed
           * @param {string} content - The content retrieved from the URL
           */
          reportUrlCitation: function (url, content, title) {
            try {
              const urlObj = new URL(url);
              this.super.addCitation?.({
                id: url,
                title: title || urlObj.hostname + urlObj.pathname,
                text: content,
                chunkSource: `link://${url}`,
                score: null,
              });
            } catch {
              this.super.addCitation?.({
                id: url,
                title: title || url,
                text: content,
                chunkSource: `link://${url}`,
                score: null,
              });
            }
          },

          /**
           * Scrape a website and truncate the content if it exceeds the token cap.
           * Uses a maxTokens cap (default 32K) independent of the model's context window,
           * so we never dump a multi-hundred-K-token page into the conversation context.
           * Oversized pages are truncated (no LLM summarization) to avoid burning credits.
           *
           * @param {string} url - The URL to scrape
           * @param {number} [maxTokens] - Token cap for the returned content (default 32000)
           * @returns {Promise<string>}
           */
          scrape: async function (url, maxTokens) {
            const DEFAULT_MAX_TOKENS = 32_000;
            const cap = Math.max(500, Math.min(maxTokens || DEFAULT_MAX_TOKENS, 128_000));

            this.super.introspect(
              `${this.caller}: Scraping the content of ${url} (cap: ${cap} tokens)`
            );
            const { success, content, title } =
              await new CollectorApi().getLinkContent(url, "markdown");

            if (!success) {
              this.super.introspect(
                `${this.caller}: could not scrape ${url}. I can't use this page's content.`
              );
              throw new Error(
                `URL could not be scraped and no content was found.`
              );
            }

            if (!content || content?.length === 0) {
              throw new Error("There was no content to be collected or read.");
            }

            this.reportUrlCitation(url, content, title);
            const { TokenManager } = require("../../../helpers/tiktoken");
            const tokenManager = new TokenManager(this.super.model);
            const tokens = tokenManager.tokensFromString(content);

            if (tokens.length <= cap) {
              this.super.introspect(
                `${this.caller}: Looking over the content of the page. ~${tokens.length} tokens (within ${cap} cap).`
              );
              return content;
            }

            // Truncate instead of summarizing - summarization costs extra LLM
            // calls/credits and can be slow. Token-accurate slice keeps valid UTF-8.
            this.super.introspect(
              `${this.caller}: Page is ~${tokens.length} tokens, exceeding the ${cap} token cap. Truncating to fit.`
            );
            const truncated = tokenManager.bytesFromTokens(
              tokens.slice(0, cap)
            );
            return `${truncated}\n\n[Content truncated: page was ~${tokens.length} tokens, showing first ${cap} tokens.]`;
          },
        });
      },
    };
  },
};

module.exports = {
  webScraping,
};
