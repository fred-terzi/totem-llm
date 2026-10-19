/**
 * F12 insertion-point (b) — the standard chat path override in
 * `resolveProviderConnector()`.
 *
 * Lives in its own file because the AgentHandler test file's jest.mock
 * registrations (notably `../../utils/inferenceOptions`) leak through the
 * file-scoped mock registry: when `resolveProviderConnector` internally
 * requires `../inferenceOptions`, it receives the AgentHandler block's mock
 * whose `resolveOverrideForUser` is a bare jest.fn() returning undefined —
 * so the override is treated as null and the test sees legacy routing.
 * (Isolated in Step 3: passes solo, fails in-suite alongside the AgentHandler
 * block. Fixed by file separation, not by weakening assertions.)
 *
 * `system_settings` is mocked so the real registry resolves the free slug
 * without a DB; everything else in the helpers graph is the real module code.
 * (The slug is inlined in the mock factory — factories may only reference
 * `mock*`-prefixed out-of-scope variables, per babel-jest.)
 */

process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(),
  InvokeModelCommand: jest.fn(),
}));

const OPTION_KEYS = {
  FREE: "totem-free",
};

describe("resolveProviderConnector chat-path override (F12 insertion point b)", () => {
  const makeIsolatedHelpers = () => {
    let helpers;
    jest.isolateModules(() => {
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
      helpers = require("../../utils/helpers");
    });
    return helpers;
  };

  beforeEach(() => {
    process.env.OPEN_AI_KEY = "test-key";
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OPEN_AI_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("default user + selection → connector built from the option, not workspace provider", async () => {
    const { resolveProviderConnector } = makeIsolatedHelpers();
    const result = await resolveProviderConnector({
      workspace: {
        chatProvider: "openai",
        chatModel: "gpt-4o",
        user_inference_option: "totem-free",
      },
      user: { id: 1, role: "default" },
    });
    expect(result.connector).toBeDefined();
    expect(result.connector.model).toBe("nvidia/nemotron-3.5-lightning:free");
    expect(result.routingMetadata).toBeNull();
  });

  it("no selection → legacy workspace routing untouched", async () => {
    const { resolveProviderConnector } = makeIsolatedHelpers();
    const legacy = await resolveProviderConnector({
      workspace: { chatProvider: "openai", chatModel: "gpt-4o" },
      user: { id: 1, role: "default" },
    });
    expect(legacy.connector.model).toBe("gpt-4o");
  });

  it("privileged user with a selection → workspace provider still wins (fail-closed)", async () => {
    const { resolveProviderConnector } = makeIsolatedHelpers();
    const admin = await resolveProviderConnector({
      workspace: {
        chatProvider: "openai",
        chatModel: "gpt-4o",
        user_inference_option: "totem-free",
      },
      user: { id: 1, role: "admin" },
    });
    expect(admin.connector.model).toBe("gpt-4o");
  });

  it("null user (embed/scheduled consumers) → legacy routing, no override", async () => {
    const { resolveProviderConnector } = makeIsolatedHelpers();
    const result = await resolveProviderConnector({
      workspace: {
        chatProvider: "openai",
        chatModel: "gpt-4o",
        user_inference_option: "totem-free",
      },
      user: null,
    });
    expect(result.connector.model).toBe("gpt-4o");
  });
});
