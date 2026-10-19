/**
 * F12 shared-guard tests — `resolveOverrideForUser` against the REAL registry,
 * with `SystemSettings` mocked at the DB boundary. Companion file
 * `inferenceOptionRouting.test.js` covers the two insertion points
 * (`AgentHandler` + `resolveProviderConnector`) with the registry mocked.
 */

process.env.STORAGE_DIR = __dirname;
process.env.NODE_ENV = "test";

jest.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: jest.fn(),
  InvokeModelCommand: jest.fn(),
}));

const {
  resolveOverrideForUser,
  OPTION_KEYS,
} = require("../../utils/inferenceOptions");

describe("resolveOverrideForUser (shared F12 guard)", () => {
  it("returns null when the workspace has no selection (N4/OQ-4)", async () => {
    const result = await resolveOverrideForUser({
      workspace: { user_inference_option: null },
      user: { id: 1, role: "default" },
    });
    expect(result).toBeNull();
  });

  it("returns null when the user is absent (fail-closed — system/scheduled invocations)", async () => {
    const result = await resolveOverrideForUser({
      workspace: { user_inference_option: OPTION_KEYS.FREE },
      user: null,
    });
    expect(result).toBeNull();
  });

  it("returns null for privileged roles (admin/manager) — user priority is default-role only", async () => {
    for (const role of ["admin", "manager"]) {
      const result = await resolveOverrideForUser({
        workspace: { user_inference_option: OPTION_KEYS.E2EE },
        user: { id: 1, role },
      });
      expect(result).toBeNull();
    }
  });

  it("returns null for unknown option keys (fail-closed → legacy routing)", async () => {
    const result = await resolveOverrideForUser({
      workspace: { user_inference_option: "totem-premium" },
      user: { id: 1, role: "default" },
    });
    expect(result).toBeNull();
  });

  it("resolves a default user's valid selection via the registry (per-request slug)", async () => {
    // Isolated module graph so a fresh registry instance picks up the
    // SystemSettings mock (the top-level require already bound the real one).
    let isolated;
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
      isolated = require("../../utils/inferenceOptions");
    });
    const result = await isolated.resolveOverrideForUser({
      workspace: { user_inference_option: OPTION_KEYS.FREE },
      user: { id: 1, role: "default" },
    });
    expect(result).not.toBeNull();
    expect(result.option.key).toBe(OPTION_KEYS.FREE);
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("nvidia/nemotron-3.5-lightning:free");
  });

  it("downgrades registry resolution errors to null (N5 — never hard-fail a chat)", async () => {
    let isolated;
    jest.isolateModules(() => {
      jest.mock("../../models/systemSettings", () => ({
        SystemSettings: {
          getValueOrFallback: jest.fn(async () => {
            throw new Error("db unreachable");
          }),
          _updateSettings: jest.fn(async () => ({ success: false })),
        },
      }));
      isolated = require("../../utils/inferenceOptions");
    });
    const result = await isolated.resolveOverrideForUser({
      workspace: { user_inference_option: OPTION_KEYS.FREE },
      user: { id: 1, role: "default" },
    });
    expect(result).toBeNull();
  });
});
