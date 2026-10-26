/**
 * Shared `<thought>` tag parsing for agent trace capture
 * (agent-full-context-trace, Step 3 / Step 1 risk note).
 *
 * Applies ONLY to provider paths where reasoning arrives embedded in the
 * text response as tagged text — the shared UnTooled plain-chat fallback
 * (helpers/untooled.js no-functions branch), Ollama's native tooled stream
 * (which appends `<thought>`-wrapped thinking into textResponse), and legacy
 * rows persisted before reasoning was threaded out as a separate field.
 *
 * The tooled path (helpers/tooled.js) returns `reasoning` separately and
 * never needs this helper for live turns.
 *
 * Tag spellings accepted:
 * - `<thought>...</thought>` — the codebase's canonical wrapper
 * - `<think>...</think>` — Ollama's UnTooled plain-chat fallback spelling
 *   (legacy rows persisted before normalization must still load clean, AC11)
 * - a stray unmatched closing tag (`</thought>` / `</think>`) with no opener —
 *   the pre-Step-3 persistence artifact (plan 0.2), stripped on cleanup
 */

const THOUGHT_TAG_RE = /<(thought|think)>([\s\S]*?)<\/\1>/g;
const STRAY_CLOSE_TAG_RE = /<\/(thought|think)>\s*/g;

/**
 * Split a (possibly tag-polluted) text response into clean text + reasoning.
 * Matched tag pairs are removed from the text and their inner content is
 * concatenated (in order) as the reasoning. A stray unmatched closing tag
 * with no opening tag is stripped from the text (artifact cleanup) but does
 * not contribute reasoning content. Text with no tags is returned unchanged
 * with empty reasoning.
 *
 * @param {string} textResponse - Raw text response, possibly `<thought>`-tagged
 * @returns {{text: string, reasoning: string}}
 */
function extractThought(textResponse = "") {
  if (typeof textResponse !== "string" || !textResponse) {
    return { text: textResponse ?? "", reasoning: "" };
  }

  let reasoning = "";
  const text = textResponse
    .replace(THOUGHT_TAG_RE, (_match, _tag, inner) => {
      reasoning += inner;
      return "";
    })
    // Legacy artifact: unmatched closing tag (persisted by the pre-Step-3
    // tooled/untooled streams). Strip it so it never reaches the model.
    .replace(STRAY_CLOSE_TAG_RE, "");

  return { text, reasoning };
}

module.exports = { extractThought };
