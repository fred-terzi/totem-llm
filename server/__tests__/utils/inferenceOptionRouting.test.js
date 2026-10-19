/**
 * F12 insertion-point (a) — the override wired into
 * `AgentHandler.#providerSetupAndCheck()` (agent path).
 *
 * Uses jest.isolateModules with an inline-mocked module graph (mock factories
 * may only close over `mock*`-prefixed variables — babel-jest rule). The
 * private `#providerSetupAndCheck` is driven through `init()`, the same
 * surface the websocket endpoint uses. The shared guard itself is covered by
 * `inferenceOptionGuard.test.js` against the real registry.
 *
 * NOTE: the `resolveProviderConnector` (standard chat path) insertion-point
 * tests live in `inferenceOptionChatPath.test.js` — the jest.mock
 * registrations in this file leak through the file-scoped mock registry and
 * would suppress the real `resolveOverrideForUser` call under test there.
 */

process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(),
  InvokeModelCommand: jest.fn(),
}));

const OPTION_KEYS = {
  FREE: "totem-free",
  ANON: "totem-anon",
  E2EE: "totem-e2ee",
};

describe("AgentHandler agent-path override (F12 insertion point a)", () => {
  let AgentHandler;
  let invocationMock;
  let userGetMock;
  let resolveOverrideMock;

  beforeAll(() => {
    jest.isolateModules(() => {
      // Factories may only close over `mock*`-prefixed vars (babel-jest rule).
      const mockResolveOverrideFn = jest.fn();
      const mockUserGetFn = jest.fn();
      const mockInvocationGetFn = jest.fn();
      resolveOverrideMock = mockResolveOverrideFn;
      userGetMock = mockUserGetFn;
      invocationMock = mockInvocationGetFn;

      jest.mock("../../models/user", () => ({
        User: {
          get: mockUserGetFn,
          canSendChat: jest.fn(async () => true),
        },
      }));
      jest.mock("../../models/workspace", () => ({
        Workspace: {
          supportsNativeToolCalling: jest.fn(async () => true),
        },
      }));
      jest.mock("../../models/workspaceAgentInvocation", () => ({
        WorkspaceAgentInvocation: {
          getWithWorkspace: mockInvocationGetFn,
        },
      }));
      jest.mock("../../utils/inferenceOptions", () => ({
        OPTION_KEYS: {
          FREE: "totem-free",
          ANON: "totem-anon",
          E2EE: "totem-e2ee",
        },
        resolveOverrideForUser: mockResolveOverrideFn,
      }));
      // Heavy transitive deps of the AgentHandler graph — not under test.
      jest.mock("../../utils/agents/aibitat", () => ({
        default: jest.fn(),
      }));
      jest.mock("../../utils/agents/aibitat/plugins", () => ({
        memory: { name: "rag-memory" },
        docSummarizer: { name: "document-summarizer" },
        webScraping: { name: "web-scraping" },
      }));
      jest.mock("../../utils/DocumentManager", () => ({
        DocumentManager: class {
          pinnedDocs() {
            return [];
          }
        },
      }));
      jest.mock("../../utils/MCP", () =>
        jest.fn().mockImplementation(() => ({}))
      );
      jest.mock("../../utils/agentFlows", () => ({
        AgentFlows: { activeFlowPlugins: jest.fn(() => []) },
      }));
      jest.mock("../../utils/agents/imported", () => ({
        activeImportedPlugins: jest.fn(() => []),
      }));
      jest.mock("../../utils/chats/agents", () => ({
        getAndClearInvocationAttachments: jest.fn(() => []),
      }));

      AgentHandler = require("../../utils/agents").AgentHandler;
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPEN_AI_KEY = "test-key";
    process.env.OPENROUTER_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.OPEN_AI_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("option set + default user → override replaces agentProvider/agentModel", async () => {
    userGetMock.mockResolvedValue({ id: 7, role: "default" });
    resolveOverrideMock.mockResolvedValue({
      option: { key: OPTION_KEYS.FREE },
      provider: "openrouter",
      model: "free/model:free",
    });
    invocationMock.mockResolvedValue({
      user_id: 7,
      workspace: {
        agentProvider: "openai",
        agentModel: "gpt-4o",
        user_inference_option: OPTION_KEYS.FREE,
      },
    });

    const initialized = await new AgentHandler({ uuid: "u1" }).init();
    expect(initialized.provider).toBe("openrouter");
    expect(initialized.model).toBe("free/model:free");
    expect(userGetMock).toHaveBeenCalledWith({ id: 7 });
    expect(resolveOverrideMock).toHaveBeenCalledWith({
      workspace: expect.objectContaining({
        user_inference_option: OPTION_KEYS.FREE,
      }),
      user: expect.objectContaining({ id: 7 }),
    });
  });

  it("option NULL → legacy chain (agentProvider/agentModel win)", async () => {
    userGetMock.mockResolvedValue({ id: 7, role: "default" });
    resolveOverrideMock.mockResolvedValue(null);
    invocationMock.mockResolvedValue({
      user_id: 7,
      workspace: { agentProvider: "openai", agentModel: "gpt-4o" },
    });

    const initialized = await new AgentHandler({ uuid: "u2" }).init();
    expect(initialized.provider).toBe("openai");
    expect(initialized.model).toBe("gpt-4o");
    expect(resolveOverrideMock).toHaveBeenCalled();
  });

  it("non-default role → legacy chain (admin workspace config unaffected)", async () => {
    userGetMock.mockResolvedValue({ id: 7, role: "admin" });
    resolveOverrideMock.mockResolvedValue(null); // guard nulls privileged roles
    invocationMock.mockResolvedValue({
      user_id: 7,
      workspace: { agentProvider: "openai", agentModel: "gpt-4o" },
    });

    const initialized = await new AgentHandler({ uuid: "u3" }).init();
    expect(initialized.provider).toBe("openai");
    expect(initialized.model).toBe("gpt-4o");
  });

  it("null user_id (system/scheduled invocation) → no user fetch, legacy chain", async () => {
    invocationMock.mockResolvedValue({
      user_id: null,
      workspace: { agentProvider: "openai", agentModel: "gpt-4o" },
    });

    const initialized = await new AgentHandler({ uuid: "u4" }).init();
    expect(userGetMock).not.toHaveBeenCalled();
    expect(initialized.provider).toBe("openai");
    expect(initialized.model).toBe("gpt-4o");
  });
});

// The resolveProviderConnector (standard chat path) insertion-point tests
// intentionally do NOT live in this file: the jest.mock registrations above
// (especially `../../utils/inferenceOptions`) leak through the file-scoped
// mock registry and would suppress the real `resolveOverrideForUser` call
// under test there. See `inferenceOptionChatPath.test.js`.
