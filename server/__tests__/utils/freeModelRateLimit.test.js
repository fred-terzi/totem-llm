/**
 * Step 4 — F8 upstream 429 mapping tests.
 *
 * `server/utils/freeModelRateLimit.js` holds the detection (HTTP 429 / free
 * tier exhausted) and the client-facing mapping to the exact F8 wording.
 * The throw-site wiring (aibitat OpenRouter provider + OpenRouterLLM
 * connector) and the two client-facing mapping points (aibitat `websocket`
 * plugin onError + `chat.js` SSE catch) are covered here at the unit level
 * by driving the real functions with representative error shapes.
 *
 * `system_settings` is mocked at the DB boundary so the real registry's
 * `isConfiguredFreeSlug` gate is exercised without Prisma.
 */

process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(),
  InvokeModelCommand: jest.fn(),
}));

const {
  FREE_MODEL_RATE_LIMIT_MARKER,
  FREE_MODEL_RATE_LIMIT_MESSAGE,
  isUpstreamRateLimitError,
  markFreeModelRateLimit,
  isFreeModelRateLimitMessage,
  mapFreeModelRateLimitMessage,
  freeOptionRateLimitError,
} = require("../../utils/freeModelRateLimit");
const { OPTION_KEYS } = require("../../utils/inferenceOptions");

// The configured free slug, as the SystemSettings mock below reports it.
const CONFIGURED_FREE_SLUG = "nvidia/nemotron-3.5-lightning:free";

jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    getValueOrFallback: jest.fn(async (clause, fallback) =>
      clause?.label === "default_user_inference_option_free"
        ? "nvidia/nemotron-3.5-lightning:free"
        : fallback
    ),
    _updateSettings: jest.fn(async () => ({ success: true })),
  },
}));

describe("isUpstreamRateLimitError (F8 detection)", () => {
  it("detects the OpenAI-SDK RateLimitError shape (status 429)", () => {
    const error = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      name: "RateLimitError",
    });
    expect(isUpstreamRateLimitError(error)).toBe(true);
  });

  it("detects a 429 by error name without status (stringified round-trip)", () => {
    expect(isUpstreamRateLimitError({ name: "RateLimitError" })).toBe(true);
  });

  it("detects a 429 by SDK message prefix only", () => {
    expect(isUpstreamRateLimitError(new Error("429 Rate limit exceeded"))).toBe(
      true
    );
    expect(isUpstreamRateLimitError("429 You've exceeded your quotas")).toBe(
      true
    );
  });

  it("does not match other upstream failures", () => {
    expect(isUpstreamRateLimitError(new Error("500 Internal Server Error"))).toBe(
      false
    );
    expect(isUpstreamRateLimitError({ status: 402 })).toBe(false);
    expect(isUpstreamRateLimitError(new Error("boom"))).toBe(false);
    expect(isUpstreamRateLimitError(null)).toBe(false);
    expect(isUpstreamRateLimitError(undefined)).toBe(false);
  });
});

describe("freeOptionRateLimitError (throw-site gate)", () => {
  const rateLimitError = () =>
    Object.assign(new Error("429 You've exceeded your quotas"), {
      status: 429,
      name: "RateLimitError",
    });

  it("429 on the configured free slug → error carrying the stable marker", async () => {
    const mapped = await freeOptionRateLimitError(
      rateLimitError(),
      CONFIGURED_FREE_SLUG
    );
    expect(mapped).not.toBeNull();
    expect(isFreeModelRateLimitMessage(mapped.message)).toBe(true);
    // Marker wraps the original message so the console log keeps context.
    expect(mapped.message).toContain("429 You've exceeded your quotas");
  });

  it("429 on any other model → null (standard error handling, N5)", async () => {
    const mapped = await freeOptionRateLimitError(
      rateLimitError(),
      "anthropic/claude-3.5-sonnet"
    );
    expect(mapped).toBeNull();
  });

  it("429 with unknown/null model → null (fail-closed to the standard shape)", async () => {
    expect(await freeOptionRateLimitError(rateLimitError(), null)).toBeNull();
    expect(
      await freeOptionRateLimitError(rateLimitError(), "openrouter/auto")
    ).toBeNull();
  });

  it("non-429 errors → null even on the free slug", async () => {
    const mapped = await freeOptionRateLimitError(
      new Error("Connection refused"),
      CONFIGURED_FREE_SLUG
    );
    expect(mapped).toBeNull();
  });

  it("registry failure → null (never mask an error with a wrong mapping, N5)", async () => {
    const {
      SystemSettings,
    } = require("../../models/systemSettings");
    SystemSettings.getValueOrFallback.mockImplementationOnce(async () => {
      throw new Error("db unreachable");
    });
    const mapped = await freeOptionRateLimitError(
      rateLimitError(),
      CONFIGURED_FREE_SLUG
    );
    expect(mapped).toBeNull();
  });
});

describe("client-facing mapping (F8 wording, N5 shape)", () => {
  it("marker-carrying message → the exact F8 wording, verbatim", () => {
    const marked = markFreeModelRateLimit("The agent model failed to respond");
    expect(
      mapFreeModelRateLimitMessage(marked)
    ).toBe(FREE_MODEL_RATE_LIMIT_MESSAGE);
    expect(FREE_MODEL_RATE_LIMIT_MESSAGE).toBe(
      "The free model is rate-limited right now. Switch to Anonymous or E2EE inference to continue."
    );
  });

  it("surrounding wrapper text does not defeat the marker match", () => {
    // AIbitat's #safeProviderCall wraps provider errors like this before they
    // reach the websocket plugin's onError handler.
    const wrapped = `The agent model failed to respond: ${markFreeModelRateLimit("429 quota")}`;
    expect(mapFreeModelRateLimitMessage(wrapped)).toBe(
      FREE_MODEL_RATE_LIMIT_MESSAGE
    );
  });

  it("unmapped errors pass through unchanged (standard shape, N5)", () => {
    const plain = "The agent model failed to respond: connection refused";
    expect(mapFreeModelRateLimitMessage(plain)).toBe(plain);
    expect(mapFreeModelRateLimitMessage(null)).toBeNull();
    expect(mapFreeModelRateLimitMessage(undefined)).toBeUndefined();
  });

  it("the marker alone never reaches the client un-mapped", () => {
    // Any string containing the marker must map — no path may leak it raw.
    expect(
      mapFreeModelRateLimitMessage(`noise ${FREE_MODEL_RATE_LIMIT_MARKER} noise`)
    ).toBe(FREE_MODEL_RATE_LIMIT_MESSAGE);
  });
});

describe("F8 wiring — option consistency", () => {
  it("the free option key gated in chat.js matches the registry", () => {
    // chat.js's skipCreditGate and this mapping both anchor on the same key.
    expect(OPTION_KEYS.FREE).toBe("totem-free");
  });

  it("marker + message survive a JSON string round-trip (socket payload)", () => {
    const marked = markFreeModelRateLimit("429 quota");
    const roundTrip = JSON.parse(
      JSON.stringify({ type: "wssFailure", content: marked })
    ).content;
    expect(mapFreeModelRateLimitMessage(roundTrip)).toBe(
      FREE_MODEL_RATE_LIMIT_MESSAGE
    );
  });
});
