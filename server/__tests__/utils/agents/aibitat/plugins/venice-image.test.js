/**
 * Venice Image Generation plugin tests (Step 4).
 *
 * Spec: totem_docs/venice-image-generate/requirement-spec.md
 * One AC → one named test per the doc-first checklist.
 *
 * Mocking strategy:
 *  - `filesystem/lib.js` is mocked with a lightweight sandbox stand-in rooted at
 *    a unique temp dir, so `saveToSandbox` writes real files but only through
 *    the same `validatePath` contract the real manager enforces. No dependency
 *    on ~/totem-llm/ or the real per-user dirs.
 *  - `models/credits` + `models/user` are mocked (no Prisma/DB).
 *  - `global.fetch` is a jest mock — no real Venice API spend (risk table row 4–5).
 *  - The plugin is registered against a stub `aibitat` instance so handlers can
 *    be invoked directly with a controllable `this.super`.
 */

const path = require("path");
const os = require("os");
const fs = require("fs/promises");

// ── Module mocks (paths resolve to the same modules the plugin requires) ──

const TMP_ROOT = path.join(os.tmpdir(), `totem-venice-img-test-${process.pid}`);

// Sandbox stand-in: same validatePath contract as FilesystemManager, scoped
// per userId exactly like getFilesystemFor. Cross-user paths are denied.
const sandboxRoots = new Map();
function mockFilesystemFor(userId) {
  const key = userId == null ? "shared" : String(userId);
  if (!sandboxRoots.has(key)) {
    const root =
      userId == null
        ? path.join(TMP_ROOT, "totemllm-fs")
        : path.join(TMP_ROOT, "totemllm-fs", "users", key);
    sandboxRoots.set(key, {
      root,
      validatePath: async (relPath) => {
        const abs = path.resolve(root, relPath);
        if (!abs.startsWith(root + path.sep) && abs !== root) {
          throw new Error(
            "Access denied - path outside allowed directories."
          );
        }
        return abs;
      },
    });
  }
  return sandboxRoots.get(key);
}

jest.mock(
  "../../../../../utils/agents/aibitat/plugins/filesystem/lib.js",
  () => ({
    getFilesystemFor: (userId) => mockFilesystemFor(userId),
  })
);

const mockCredits = {
  hasCredits: jest.fn(),
  debit: jest.fn(),
};
jest.mock("../../../../../models/credits", () => ({
  Credits: mockCredits,
}));

const mockUser = { get: jest.fn() };
jest.mock("../../../../../models/user", () => ({ User: mockUser }));

// ── Requires (after mocks) ──────────────────────────────────────────
const pricing = require("../../../../../utils/agents/aibitat/plugins/venice-image/pricing.js");
const {
  VeniceImageManager,
  veniceImageManager,
} = require("../../../../../utils/agents/aibitat/plugins/venice-image/lib.js");
const {
  veniceImage,
} = require("../../../../../utils/agents/aibitat/plugins/venice-image/index.js");

const USER_ID = 9999;

// ── Harness ─────────────────────────────────────────────────────────
function makeAibitat({ userId = USER_ID } = {}) {
  const fns = {};
  const aibitat = {
    function: jest.fn((def) => {
      fns[def.name] = def;
    }),
    introspect: jest.fn(),
    handlerProps: { userId, log: jest.fn() },
    socket: { send: jest.fn() },
    registerOutput: jest.fn(),
    requestToolApproval: jest.fn(),
  };
  return { aibitat, fns };
}

/** Register the plugin (all sub-plugins) on a fresh stub and return the named tool def. */
function getHandler(aibitat, fns, toolName = "generate-image") {
  // plugin is now an array of sub-plugin defs (sub-plugin convention).
  for (const sub of veniceImage.plugin) sub.plugin().setup(aibitat);
  const def = fns[toolName];
  if (!def) throw new Error(`tool ${toolName} was not registered`);
  return def;
}

function okFetchResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function b64(s) {
  return Buffer.from(s, "utf-8").toString("base64");
}

beforeAll(() => {
  process.env.VENICE_API_KEY = "test-venice-key";
  global.fetch = jest.fn();
  mockUser.get.mockResolvedValue({ id: USER_ID, role: "default" });
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch.mockReset();
  mockCredits.hasCredits.mockResolvedValue(true);
  mockCredits.debit.mockResolvedValue({
    userId: USER_ID,
    debited: 10000,
    newBalance: 0,
  });
  mockUser.get.mockResolvedValue({ id: USER_ID, role: "default" });
  process.env.VENICE_API_KEY = "test-venice-key";
});

// ════════════════════════════════════════════════════════════════════
// F12 / F13 / N4 — pricing.quote unit tests
// ════════════════════════════════════════════════════════════════════
describe("pricing.quote (F12, F13, N4)", () => {
  test("N4 — 1 variant quotes exactly COST_PER_IMAGE", () => {
    expect(pricing.quote({})).toBe(pricing.COST_PER_IMAGE);
    expect(pricing.quote({ variants: 1 })).toBe(pricing.COST_PER_IMAGE);
    expect(pricing.quote({ variants: 2 })).toBe(
      pricing.COST_PER_IMAGE * 2
    );
  });

  test("N4 — variants above 4 are capped at ×4", () => {
    expect(pricing.quote({ variants: 4 })).toBe(
      pricing.COST_PER_IMAGE * 4
    );
    expect(pricing.quote({ variants: 99 })).toBe(
      pricing.COST_PER_IMAGE * 4
    );
    expect(pricing.quote({ variants: "not-a-number" })).toBe(
      pricing.COST_PER_IMAGE
    );
  });

  test("F12/N4 — handler debit amount equals pricing.quote(params) for the same params (quote and debit cannot diverge)", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue({
      approved: true,
      message: "approved",
    });
    global.fetch.mockResolvedValue(
      okFetchResponse({ id: "req_quote_1", images: [b64("img")] })
    );
    const params = { prompt: "a lighthouse at dusk", variants: 3 };
    await def.handler.call(
      { super: aibitat, caller: "test" },
      params
    );
    expect(mockCredits.debit).toHaveBeenCalledTimes(1);
    const [debitedUserId, debitedAmount] = mockCredits.debit.mock.calls[0];
    expect(debitedUserId).toBe(USER_ID);
    expect(debitedAmount).toBe(pricing.quote(params));
    expect(debitedAmount).toBe(pricing.COST_PER_IMAGE * 3);
  });
});

// ════════════════════════════════════════════════════════════════════
// AC10 / AC17 — tool-description contract (refine-and-confirm mandate)
// ════════════════════════════════════════════════════════════════════
describe("tool description contract (AC10, AC17)", () => {
  test("AC10 — generate-image description carries the refine-and-confirm mandate and a credit-quote instruction", () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    const description = def.description.toLowerCase();
    expect(description).toContain("refine");
    expect(description).toContain("present");
    expect(description).toContain("credit");
    expect(description).toContain("wait");
    expect(description).toContain("never call this tool");
  });

  test("AC17 — mandate explicitly holds for 'Always allow' (auto-approved) users", () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    const description = def.description.toLowerCase();
    expect(description).toContain("always allow");
    expect(description).toContain("every user");
  });
});

// ════════════════════════════════════════════════════════════════════
// F1 / F9 / F13 — buildRequestBody unit tests
// ════════════════════════════════════════════════════════════════════
describe("buildRequestBody (F1, F9, F13)", () => {
  test("F1 — sizing-idiom exclusivity: aspect_ratio present drops width/height; width/height present drops aspect_ratio/resolution", () => {
    const mgr = new VeniceImageManager();
    const aspectBody = mgr.buildRequestBody({
      prompt: "p",
      aspect_ratio: "16:9",
      width: 1024,
      height: 1024,
    });
    expect(aspectBody.aspect_ratio).toBe("16:9");
    expect(aspectBody.width).toBeUndefined();
    expect(aspectBody.height).toBeUndefined();

    // Both idioms supplied: the implementation resolves the conflict
    // deterministically — aspect_ratio wins, dimensions dropped. The invariant
    // under test is that the outgoing body NEVER carries both idioms.
    const bothBody = mgr.buildRequestBody({
      prompt: "p",
      width: 768,
      height: 1280,
      aspect_ratio: "16:9",
      resolution: "2K",
    });
    const hasAspectIdiom =
      bothBody.aspect_ratio != null || bothBody.resolution != null;
    const hasDimIdiom = bothBody.width != null || bothBody.height != null;
    expect(hasAspectIdiom && hasDimIdiom).toBe(false);
    expect(bothBody.aspect_ratio).toBe("16:9");
    expect(bothBody.resolution).toBe("2K");
  });

  test("F13 — model is never overridable and the deprecated inpaint field is never sent", () => {
    const mgr = new VeniceImageManager();
    const body = mgr.buildRequestBody({
      prompt: "p",
      model: "some-expensive-model",
      inpaint: { anything: true },
    });
    expect(body.model).toBe(pricing.STANDARD_MODEL);
    expect(body.model).toBe("z-image-turbo");
    expect(body).not.toHaveProperty("inpaint");
  });

  test("F9 — defaults: format png, return_binary always false, variants omitted at 1 and capped at 4", () => {
    const mgr = new VeniceImageManager();
    const minimal = mgr.buildRequestBody({ prompt: "p" });
    expect(minimal.format).toBe("png");
    expect(minimal.return_binary).toBe(false);
    expect(minimal).not.toHaveProperty("variants");

    const overCap = mgr.buildRequestBody({
      prompt: "p",
      variants: 12,
      return_binary: true,
    });
    expect(overCap.variants).toBe(4);
    expect(overCap.return_binary).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// AC9 — sanitizeSlug hostile-input handling
// ════════════════════════════════════════════════════════════════════
describe("sanitizeSlug (AC9)", () => {
  const mgr = new VeniceImageManager();

  test("AC9 — path traversal input yields a safe flat slug", () => {
    expect(mgr.sanitizeSlug("../../etc/passwd lighthouse")).toBe(
      "etc-passwd-lighthouse"
    );
    expect(mgr.sanitizeSlug("..\\..\\windows\\system32")).not.toMatch(
      /\\|\.\./
    );
  });

  test("AC9 — unicode, emoji, newlines, and quotes are stripped or transliterated to safe characters", () => {
    const slug = mgr.sanitizeSlug(
      '🖼️ "Lumière" — lighthouse\nat <dusk>?/etc'
    );
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug).not.toMatch(/[^\x20-\x7E]/);
    expect(slug.length).toBeLessThanOrEqual(48);

    // Empty/hostile-only input falls back to a safe placeholder slug.
    expect(mgr.sanitizeSlug("")).toBe("");
    expect(mgr.sanitizeSlug("🎉🎉🎉")).toBe("");
    const hostileName = mgr.buildFilename({ prompt: "🎉" });
    expect(hostileName.relativePath).toMatch(/^images\/[0-9-]+image\.png$/);
    expect(hostileName.displayFilename).toBe(
      hostileName.relativePath.split("/")[1]
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// AC5 — generate() error mapping (mocked fetch)
// ════════════════════════════════════════════════════════════════════
describe("generate error mapping (AC5)", () => {
  const mgr = new VeniceImageManager();

  async function expectStatusMessage(status, bodyText, matcher) {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => bodyText,
    });
    await expect(mgr.generate({ prompt: "p" })).rejects.toThrow(matcher);
  }

  test("AC5 — 400 surfaces the API error string (content policy)", async () => {
    await expectStatusMessage(
      400,
      JSON.stringify({ error: "Your prompt was flagged by content policy" }),
      /content policy/i
    );
  });

  test("AC5 — 401 maps to an auth message", async () => {
    await expectStatusMessage(401, "{}", /authentication failed/i);
  });

  test("AC5 — 402 maps to an operator top-up message", async () => {
    await expectStatusMessage(
      402,
      JSON.stringify({ error: "Insufficient balance" }),
      /venice api balance|top up/i
    );
  });

  test("AC5 — 429 maps to a rate-limit message", async () => {
    await expectStatusMessage(429, "{}", /rate limited/i);
  });

  test("AC5 — 503 maps to a capacity/retry message", async () => {
    await expectStatusMessage(503, "{}", /unavailable|retry/i);
  });

  test("AC5 — network failure maps to a could-not-reach message", async () => {
    global.fetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(mgr.generate({ prompt: "p" })).rejects.toThrow(
      /could not reach the venice image api/i
    );
  });
});

// ════════════════════════════════════════════════════════════════════
// AC3 / N1 — saveToSandbox (validatePath gate + sandbox-rooted writes)
// ════════════════════════════════════════════════════════════════════
describe("saveToSandbox (AC3, N1)", () => {
  test("AC3/N1 — writes land inside the requesting user's sandbox root under images/", async () => {
    const root = mockFilesystemFor(USER_ID).root;
    const { absolutePath, relativePath } =
      await veniceImageManager.saveToSandbox({
        userId: USER_ID,
        buffer: Buffer.from("png-bytes-user-a"),
        relativePath: "images/20261020-000000-test-a.png",
      });
    expect(relativePath).toBe("images/20261020-000000-test-a.png");
    expect(absolutePath.startsWith(path.join(root, "images"))).toBe(true);
    const onDisk = await fs.readFile(absolutePath);
    expect(onDisk.toString()).toBe("png-bytes-user-a");
  });

  test("AC3 — another user's sandbox cannot resolve the first user's image path (Access denied)", async () => {
    const otherId = 131313;
    const absA = path.join(
      mockFilesystemFor(USER_ID).root,
      "images",
      "secret.png"
    );
    const fsB = mockFilesystemFor(otherId);
    await expect(fsB.validatePath(absA)).rejects.toThrow("Access denied");
    // And a third user is denied too.
    const fsC = mockFilesystemFor(555555);
    await expect(fsC.validatePath(absA)).rejects.toThrow("Access denied");
  });

  test("AC9 — traversal-bearing relative paths cannot escape the sandbox root", async () => {
    const root = mockFilesystemFor(USER_ID).root;
    await expect(
      veniceImageManager.saveToSandbox({
        userId: USER_ID,
        buffer: Buffer.from("evil"),
        relativePath: "../escape.png",
      })
    ).rejects.toThrow("Access denied");
    // Nothing was written outside the sandbox
    const escaped = path.join(TMP_ROOT, "escape.png");
    await expect(fs.stat(escaped)).rejects.toThrow();
    expect(root).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════
// Handler — billing (AC11, AC12, AC13, AC14)
// ════════════════════════════════════════════════════════════════════
describe("generate-image handler billing (AC11–AC14)", () => {
  function approvedGate() {
    return { approved: true, message: "User approved the tool execution." };
  }

  test("AC11 — insufficient balance: no fetch, no debit, human-readable message", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue(approvedGate());
    mockCredits.hasCredits.mockResolvedValue(false);

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk" }
    );

    expect(result).toMatch(/insufficient credits/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockCredits.debit).not.toHaveBeenCalled();
  });

  test("AC12 — success with userId: exactly one debit of quote(params) with venice-image-generate:<requestId> reference", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue(approvedGate());
    global.fetch.mockResolvedValue(
      okFetchResponse({ id: "req_test_123", images: [b64("one-image")] })
    );

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk" }
    );

    expect(result).toMatch(/success/i);
    expect(mockCredits.debit).toHaveBeenCalledTimes(1);
    const [debitedUserId, debitedAmount, reference] =
      mockCredits.debit.mock.calls[0];
    expect(debitedUserId).toBe(USER_ID);
    expect(debitedAmount).toBe(pricing.quote({ prompt: "a lighthouse at dusk" }));
    expect(reference).toBe("venice-image-generate:req_test_123");
  });

  test("AC13 — Venice failure after pre-flight: no debit, no-charge message", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue(approvedGate());
    global.fetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "{}",
    });

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk" }
    );

    expect(result).toMatch(/failed/i);
    expect(result).toMatch(/no credits were charged/i);
    expect(global.fetch).toHaveBeenCalled();
    expect(mockCredits.debit).not.toHaveBeenCalled();
  });

  test("AC14 — single-user mode (userId == null): no hasCredits, no debit, no admin lookup", async () => {
    const { aibitat, fns } = makeAibitat({ userId: null });
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue(approvedGate());
    global.fetch.mockResolvedValue(
      okFetchResponse({ id: "req_solo", images: [b64("solo")] })
    );

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk" }
    );

    expect(result).toMatch(/success/i);
    expect(mockCredits.hasCredits).not.toHaveBeenCalled();
    expect(mockCredits.debit).not.toHaveBeenCalled();
    expect(mockUser.get).not.toHaveBeenCalled();
  });

  test("F14 amendment — admins are billing-exempt (no pre-flight, no debit)", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue(approvedGate());
    mockUser.get.mockResolvedValue({ id: USER_ID, role: "admin" });
    global.fetch.mockResolvedValue(
      okFetchResponse({ id: "req_admin", images: [b64("admin-img")] })
    );

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk" }
    );

    expect(result).toMatch(/success/i);
    expect(mockCredits.hasCredits).not.toHaveBeenCalled();
    expect(mockCredits.debit).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// Handler — approval gate (AC8, AC15, AC16)
// ════════════════════════════════════════════════════════════════════
describe("generate-image handler approval gate (AC8, AC15, AC16)", () => {
  test("AC8 — gate invoked before fetch/hasCredits with payload carrying prompt + credit_quote", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue({
      approved: true,
      message: "approved",
    });
    global.fetch.mockResolvedValue(
      okFetchResponse({ id: "req_gate", images: [b64("g")] })
    );

    await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk", variants: 2 }
    );

    expect(aibitat.requestToolApproval).toHaveBeenCalledTimes(1);
    const gateArgs = aibitat.requestToolApproval.mock.calls[0][0];
    expect(gateArgs.skillName).toBe("venice-image-generate");
    expect(gateArgs.payload.prompt).toBe("a lighthouse at dusk");
    expect(gateArgs.payload.credit_quote).toBe(
      pricing.quote({ variants: 2 })
    );
    expect(gateArgs.description).toMatch(/costs \d+ credits/i);

    const gateOrder = aibitat.requestToolApproval.mock.invocationCallOrder[0];
    const fetchOrder = global.fetch.mock.invocationCallOrder[0];
    const preflightOrder = mockCredits.hasCredits.mock.invocationCallOrder[0];
    expect(gateOrder).toBeLessThan(fetchOrder);
    expect(gateOrder).toBeLessThan(preflightOrder);
  });

  test("AC15 — rejected gate: no fetch, no pre-flight, no debit, rejection message returned", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue({
      approved: false,
      message: "Tool call was rejected by the user.",
    });

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk" }
    );

    expect(result).toBe("Tool call was rejected by the user.");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockCredits.hasCredits).not.toHaveBeenCalled();
    expect(mockCredits.debit).not.toHaveBeenCalled();
  });

  test("AC15 — timeout treated as rejection (gate resolves not-approved)", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    // The real gate resolves { approved: false } on timeout; simulate that shape.
    aibitat.requestToolApproval.mockResolvedValue({
      approved: false,
      message: "Approval request timed out.",
    });

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk" }
    );

    expect(result).toMatch(/timed out/i);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockCredits.debit).not.toHaveBeenCalled();
  });

  test("AC16 — whitelisted/auto-approved user: gate still invoked (it short-circuits internally), flow proceeds with billing", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    // Simulates the real gate's auto-approval short-circuit for whitelisted skills.
    aibitat.requestToolApproval.mockResolvedValue({
      approved: true,
      message: "Skill is whitelisted - auto-approved.",
    });
    global.fetch.mockResolvedValue(
      okFetchResponse({ id: "req_auto", images: [b64("auto")] })
    );

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk" }
    );

    expect(aibitat.requestToolApproval).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/success/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockCredits.debit).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// Handler — availability + outputs (AC4, AC6)
// ════════════════════════════════════════════════════════════════════
describe("generate-image handler availability and outputs (AC4, AC6)", () => {
  test("AC4 — no VENICE_API_KEY: disabled message, no fetch, no debit", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns);
    delete process.env.VENICE_API_KEY;

    try {
      const result = await def.handler.call(
        { super: aibitat, caller: "test" },
        { prompt: "a lighthouse at dusk" }
      );
      expect(result).toMatch(/disabled/i);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockCredits.debit).not.toHaveBeenCalled();
      expect(aibitat.requestToolApproval).not.toHaveBeenCalled();
    } finally {
      process.env.VENICE_API_KEY = "test-venice-key";
    }
  });

  test("AC6 — N variants: N files saved, N download cards emitted with sandboxFile payload, one debit of N × COST_PER_IMAGE", async () => {
    // Unique user id → fresh sandbox dir, so the saved-file listing is exact.
    const ac6UserId = 777001;
    const { aibitat, fns } = makeAibitat({ userId: ac6UserId });
    const def = getHandler(aibitat, fns);
    aibitat.requestToolApproval.mockResolvedValue({
      approved: true,
      message: "approved",
    });
    global.fetch.mockResolvedValue(
      okFetchResponse({
        id: "req_multi",
        images: [b64("a"), b64("b"), b64("c")],
      })
    );

    const result = await def.handler.call(
      { super: aibitat, caller: "test" },
      { prompt: "a lighthouse at dusk", variants: 3 }
    );

    // 3 saved files inside the sandbox (fresh per-user dir → exact listing)
    const root = mockFilesystemFor(ac6UserId).root;
    const imagesDir = await fs.readdir(path.join(root, "images"));
    const savedFiles = imagesDir.filter((f) => f.endsWith(".png"));
    expect(savedFiles.length).toBe(3);
    // variant suffixes -1/-2/-3 when >1 image
    for (const n of ["-1", "-2", "-3"]) {
      expect(savedFiles.some((f) => f.includes(n))).toBe(true);
    }

    // 3 download cards + 3 ImageDownload outputs, all sandbox-scoped
    expect(aibitat.socket.send).toHaveBeenCalledTimes(3);
    for (const call of aibitat.socket.send.mock.calls) {
      expect(call[0]).toBe("fileDownloadCard");
      expect(call[1].sandboxFile).toBe(true);
      expect(call[1].storageFilename).toMatch(/^images\//);
    }
    expect(aibitat.registerOutput).toHaveBeenCalledTimes(3);
    for (const call of aibitat.registerOutput.mock.calls) {
      expect(call[0]).toBe("ImageDownload");
      expect(call[2]).toBe("venice-image-generate");
    }

    // one debit for the full quote
    expect(mockCredits.debit).toHaveBeenCalledTimes(1);
    expect(mockCredits.debit.mock.calls[0][1]).toBe(
      pricing.quote({ variants: 3 })
    );
    expect(mockCredits.debit.mock.calls[0][2]).toBe(
      "venice-image-generate:req_multi"
    );
    expect(result).toMatch(/3 image/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// list-image-styles tool (F7)
// ════════════════════════════════════════════════════════════════════
describe("list-image-styles tool (F7)", () => {
  test("returns style preset names from GET /image/styles", async () => {
    const { aibitat, fns } = makeAibitat();
    const def = getHandler(aibitat, fns, "list-image-styles");
    global.fetch.mockResolvedValue(
      okFetchResponse({
        styles: [{ name: "3D Model" }, { name: "Photographic" }, null],
      })
    );

    const result = await def.handler.call({ super: aibitat, caller: "test" });
    const parsed = JSON.parse(result);
    expect(parsed.styles).toEqual(["3D Model", "Photographic"]);
    expect(global.fetch.mock.calls[0][0]).toContain("/image/styles");
  });
});
