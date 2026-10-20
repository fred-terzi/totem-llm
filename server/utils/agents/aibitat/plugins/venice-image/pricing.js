/**
 * Venice Image Generation — pricing module.
 *
 * Single source of truth for the cost of every Venice image operation (spec N4, F13).
 * The quote presented to the user (F12) and the amount debited (F14) BOTH read from
 * this module — they cannot diverge. No tool, handler, or prompt may hardcode a cost.
 *
 * Units:
 *  - Internally, Totem billing works in microdollars (1 µ$ = $0.000001).
 *  - The customer-facing unit is the opaque display "credit". The CreditBadge renders
 *    the raw integer from `users.credits_balance`, which is stored in microdollars —
 *    so for this plugin, 1 display credit = 1 microdollar. Cost constants here are
 *    expressed in that display-credit integer. Microdollar/dollar values must never
 *    be rendered to end users (repo gotcha) — only the credit integer is shown.
 *
 * Extensibility (F13): `operations` is keyed by operation name. v1 ships only
 * `generate` (flat cost). Future operations (edit, upscale, video) register their own
 * `costFor(params)` functions here — size-, resolution-, and duration-dependent
 * pricing slots in without touching tools, handlers, or the confirmation flow.
 */

// Pinned 2026-10-20 from GET https://api.venice.ai/api/v1/models?type=image
// → z-image-turbo → model_spec.pricing.generation.usd = 0.01 (see implementation-plan
// Step 1 "pin the cost" evidence). Re-pin manually if the standardized model changes.
const GENERATION_COST_USD = 0.01;

const MICRO_PER_USD = 1_000_000;

// Margin policy: multiplier applied on top of Venice's break-even API cost to set
// the user-facing price. 1 = break-even pass-through; 2 = 100% margin (the operator
// keeps half of every charge). Set by the product owner 2026-10-20.
const USER_MARKUP = 2;

// Display-credit cost of ONE image with the standardized model (20,000 credits
// at the current 2× markup — $0.02 user-facing against $0.01 API cost).
const COST_PER_IMAGE = Math.round(
  GENERATION_COST_USD * MICRO_PER_USD * USER_MARKUP
);

// The v1 standardized model (spec F13). Never exposed as a tool parameter.
const STANDARD_MODEL = "z-image-turbo";

/**
 * Operation → cost function map. Each entry: { label, costFor(params) }.
 * costFor returns the display-credit integer for the given tool parameters.
 */
const operations = {
  generate: {
    label: "image generation",
    /**
     * @param {{variants?: number}} [params]
     * @returns {number} display-credit integer (COST_PER_IMAGE × variants, capped at 4)
     */
    costFor(params = {}) {
      const requested = parseInt(params?.variants, 10);
      const variants = Math.max(
        1,
        Math.min(Number.isFinite(requested) ? requested : 1, 4)
      );
      return COST_PER_IMAGE * variants;
    },
  },
  // Future: edit, upscale, video — each with its own params-driven costFor().
};

/**
 * Quote the display-credit cost for an operation.
 * The ONLY sanctioned way to obtain a cost anywhere in this plugin (F12, N4).
 *
 * @param {object} [params] - tool call parameters affecting cost (e.g. variants)
 * @param {string} [operation="generate"] - key into `operations`
 * @returns {number} display-credit integer (0 for unknown operations)
 */
function quote(params = {}, operation = "generate") {
  const op = operations[operation];
  if (!op || typeof op.costFor !== "function") return 0;
  return op.costFor(params);
}

module.exports = {
  STANDARD_MODEL,
  COST_PER_IMAGE,
  GENERATION_COST_USD,
  MICRO_PER_USD,
  operations,
  quote,
};
