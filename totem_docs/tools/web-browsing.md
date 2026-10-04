# web-browsing

## Purpose

Search the internet for real-time information. Looks online for current news,
recent updates, latest changes, or any data that isn't available locally. Use it
to find answers about current events, prices, weather, version numbers, release
notes, documentation locations, or live data you can't know from your training
cutoff. It returns search results (typically titles + snippets + URLs) rather
than the full text of a page — pair with `web-scraping` to read a specific result
in full.

**When to use:** You need up-to-date or external information and **don't yet
have an exact URL**. "What's the latest Node 18 patch version?", "Has package X
broken in v3?", "Where are the official docs for Y?" — start here, then
`web-scraping` on the best hit.

**When NOT to use:**
- You already have a specific URL → `web-scraping` directly (faster, fuller text).
- The answer lives in the local repo/filesystem → search/read locally first;
  don't burn a web search for something you can find with
  `filesystem-search-files`.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` | ✅ Yes | A natural-language or keyword search query. Specific, well-scoped queries return better results than vague ones — include product/package names, version numbers, error messages verbatim, and dates when relevant ("latest", "2026"). |

## Returns

A set of search results. Each result typically includes:
- A **title** for the source page
- A **snippet / excerpt** with context around the match
- A **URL** you can pass to `web-scraping` to read in full

The exact shape varies by backend, but the URL is always present so you can drill
into any result. No results returns an empty set or a "nothing found" note —
rephrase the query (synonyms, fewer keywords) rather than assuming there's no
information online.

## Examples

```jsonc
// Current version / release info
{ "query": "latest stable Node.js 18.x patch version August 2026" }

// Find docs for a specific behavior
{ "query": "Prisma SQLite full-text search supported site:prisma.io" }

// Track down the source of an error message
{ "query": "\"verifyPayloadIntegrity\" HMAC comKey AnythingLLM collector" }

// Recent changes / news
{ "query": "AnythingLLM changelog 2026 breaking changes embeddings" }
```

## Gotchas & Caveats

- **Search ≠ read.** Results are snippets + URLs, not full pages. To get the
  actual content, take a promising URL and call `web-scraping` on it. This is the
  intended two-step flow: browse to locate → scrape to read.

- **Recency isn't guaranteed in ranking.** Engines may surface older but more
  authoritative pages first. Include time cues in the query ("2026", "latest")
  and verify dates on scraped results before trusting them as current.

- **Quality varies with query specificity.** Over-broad queries return generic
  top-of-funnel results; over-narrow ones may miss. Iterate: start moderately
  specific, then refine based on what comes back (add/remove keywords, add a
  `site:` qualifier to target official docs).

- **Quoting error messages verbatim** is the highest-leverage trick for debugging
  searches — exact phrases in quotes match far better than paraphrases.

- **No authentication / no headless rendering here.** This is a search interface;
  for authenticated or JS-rendered content, scrape the URL (and if it's still not
  enough, fall back to `terminal-access` with `curl`/a headless browser).
