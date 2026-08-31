# web-scraping

## Purpose

Read and extract the text content from a specific webpage URL. Use this tool
when you already have an exact URL and need to see what's on that page — for
example, reading API docs, changelogs, READMEs on GitHub, blog posts, or any
other web resource. It returns the visible text of the page (HTML stripped),
not the raw HTML source.

**When to use:** You have a specific URL and want its content as readable text.

**When NOT to use:**
- You don't know the exact URL → use `web-browsing` to search first, then
  follow up with `web-scraping` on promising results.
- You need raw HTML (CSS selectors, meta tags) → this tool strips markup;
  for raw source, consider fetching via `terminal-access` with `curl`.

## Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | `string` | ✅ Yes | A complete web address including protocol (`https://…`). If no protocol is provided, `https://` is assumed. Must be a fully qualified URL — relative paths or bare hostnames without protocol will fail silently or default to HTTPS. |

## Returns

A string containing the extracted text content of the page. The exact format
varies by implementation but generally includes:
- Visible text (paragraphs, headings, list items)
- Some structural markers (headings preserved as `#` prefixes in markdown-style output)
- Links may be rendered inline or stripped

On failure (404, network error, timeout), the tool returns an error message
describing what went wrong. It does **not** throw — it degrades gracefully so
the agent can react to the failure textually.

## Examples

```jsonc
// Read a GitHub README
{ "url": "https://github.com/Mintplex-Labs/anything-llm/blob/master/README.md" }

// Read an API documentation page
{ "url": "https://docs.openai.com/api-reference/chat" }

// Protocol omitted — defaults to https
{ "url": "example.com/docs/installation" }
```

## Gotchas & Caveats

- **No JavaScript execution.** The tool fetches the server-rendered HTML. If a
  page is a single-page app (SPA) that renders content client-side, you will
  get an empty or near-empty result. For JS-heavy pages, consider using
  `terminal-access` with a headless browser (`puppeteer`, `playwright`) if
  available in the environment.

- **Large pages can be truncated.** Very long pages (e.g., full documentation
  sites) may have their output capped at a maximum length. If you need a
  specific section, try navigating to an anchor URL or a more specific sub-page.

- **Not for binary content.** PDFs, images, and other non-text resources are
  not meaningfully extracted here. For PDFs in the local filesystem, use
  `filesystem-read-text-file` which supports transcription/extraction of
  many file types.

- **Protocol defaulting.** If you pass a URL without a protocol, `https://`
  is prepended. This means plain HTTP (non-TLS) endpoints require you to
  explicitly include `http://`.

- **No auth headers.** The tool does not support custom headers or cookies.
  For authenticated pages, use `terminal-access` with `curl -H "Authorization: …"`.
