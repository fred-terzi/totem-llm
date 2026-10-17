/**
 * Per-user filesystem isolation tests.
 *
 * Verifies the 6 acceptance criteria from:
 *   totem_docs/per-user-filesystem/requirement-spec.md
 *
 * These tests exercise the security boundary in lib.js (FilesystemManager
 * + getFilesystemFor) directly — no AIbitat instance, no provider mock,
 * no fake `super` objects.  The plugin handlers all delegate to
 * `validatePath()` / `getAllowedDirectories()`, so testing those methods
 * covers the same guarantee.
 *
 * Storage isolation:
 *   process.env.STORAGE_DIR is set to a unique temp dir BEFORE the first
 *   `require("./lib.js")`, so every filesystem operation in this file lands
 *   under /tmp/totem-fs-test-<pid>/ — never ~/totem-llm/.
 *   Jest gives each test file its own module registry, so the
 *   perUserRegistry singleton won't leak into other test files.
 */

const path = require("path");
const os = require("os");
const fs = require("fs/promises");

// ── Isolate STORAGE_DIR BEFORE any require of lib.js ──────────────
const TEST_STORAGE = path.join(os.tmpdir(), `totem-fs-test-${process.pid}`);
process.env.STORAGE_DIR = TEST_STORAGE;

// Now safe to require — the default root will be <TEST_STORAGE>/totemllm-fs
// and per-user roots will be <TEST_STORAGE>/totemllm-fs/users/<id>/
const { getFilesystemFor } = require("../../../../../../utils/agents/aibitat/plugins/filesystem/lib.js");

const USER_A = 42;
const USER_B = 7;

// ── Helpers ─────────────────────────────────────────────────────────
async function writeFixture(fsInstance, relPath, content) {
  const abs = path.join(
    fsInstance.getAllowedDirectories()[0],
    relPath
  );
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf-8");
  return abs;
}

async function fsFor(userId) {
  const fsInstance = getFilesystemFor(userId);
  await fsInstance.ensureInitialized();
  return fsInstance;
}

// ── Lifecycle ───────────────────────────────────────────────────────
beforeAll(async () => {
  // Ensure the base sandbox dirs exist
  const fsA = await fsFor(USER_A);
  const fsB = await fsFor(USER_B);
  // (ensureInitialized already created the dirs)
});

afterAll(async () => {
  await fs.rm(TEST_STORAGE, { recursive: true, force: true });
});

// ── AC1: Two-user isolation ─────────────────────────────────────────
describe("AC1 — two-user isolation", () => {
  test("files written by user A are not visible to user B", async () => {
    const fsA = await fsFor(USER_A);
    const fsB = await fsFor(USER_B);

    const absA = await writeFixture(fsA, "notes.md", "secret notes from A");

    // B tries to list a directory that would contain A's file
    const bRoot = fsB.getAllowedDirectories()[0];
    const aRoot = fsA.getAllowedDirectories()[0];

    // The roots must be different
    expect(aRoot).not.toEqual(bRoot);

    // A's file must NOT be inside B's allowed dir
    expect(absA.startsWith(bRoot)).toBe(false);

    // B's validatePath on A's absolute file → must throw
    await expect(
      fsB.validatePath(absA)
    ).rejects.toThrow("Access denied");
  });
});

// ── AC2: Cross-user read → "Access denied" ─────────────────────────
describe("AC2 — cross-user read denied", () => {
  test("user B cannot validate a path inside user A's sandbox", async () => {
    const fsA = await fsFor(USER_A);
    const fsB = await fsFor(USER_B);

    const absA = await writeFixture(fsA, "private.txt", "A only");

    // B attempting to read A's file
    await expect(fsB.validatePath(absA)).rejects.toThrow(
      "Access denied - path outside allowed directories."
    );

    // A can still read their own file
    const validated = await fsA.validatePath(absA);
    expect(validated).toBe(absA);
  });
});

// ── AC3: Symlink escape rejected ────────────────────────────────────
describe("AC3 — symlink escape rejected", () => {
  test("symlink pointing outside the sandbox is denied", async () => {
    const fsA = await fsFor(USER_A);
    const fsB = await fsFor(USER_B);

    const aRoot = fsA.getAllowedDirectories()[0];
    const bRoot = fsB.getAllowedDirectories()[0];

    // Put a real file in B's dir
    const bFile = path.join(bRoot, "b-secret.txt");
    await fs.writeFile(bFile, "B only", "utf-8");

    // Create a symlink in A's dir that points to B's file
    const linkPath = path.join(aRoot, "escape-link");
    try {
      await fs.symlink(bFile, linkPath);
    } catch {
      // On some systems (Windows) symlink creation may fail; skip
      return this.skip();
    }

    // A tries to validate the symlink path → must be denied
    await expect(fsA.validatePath(linkPath)).rejects.toThrow(
      "Access denied"
    );

    // Cleanup the symlink
    await fs.rm(linkPath, { force: true });
  });
});

// ── AC4: Single-user fallback (F5) ─────────────────────────────────
describe("AC4 — single-user fallback (userId = null)", () => {
  test("null userId returns the default root, not a users/ subdir", async () => {
    const fsDefault = await fsFor(null);
    const roots = fsDefault.getAllowedDirectories();

    // The default root should be <TEST_STORAGE>/totemllm-fs
    const expectedDefault = path.join(TEST_STORAGE, "totemllm-fs");
    expect(roots).toEqual([expectedDefault]);

    // And it should NOT be under users/
    expect(roots[0]).not.toMatch(/\/users\/\d+$/);

    // Write + read back to confirm it works
    const testFile = path.join(roots[0], "shared-mode.txt");
    await fs.writeFile(testFile, "legacy", "utf-8");
    const validated = await fsDefault.validatePath(testFile);
    expect(validated).toBe(testFile);
  });
});

// ── AC5: File lands in users/<id>/ ─────────────────────────────────
describe("AC5 — user files land in users/<id>/", () => {
  test("a file in the user's sandbox is accessible via absolute path", async () => {
    const fsA = await fsFor(USER_A);
    const aRoot = fsA.getAllowedDirectories()[0];

    // The root should be <TEST_STORAGE>/totemllm-fs/users/42
    const expected = path.join(TEST_STORAGE, "totemllm-fs", "users", "42");
    expect(aRoot).toBe(expected);

    // Write a file at the root of A's sandbox
    const cfg = path.join(aRoot, "config.json");
    await fs.writeFile(cfg, '{"ok":true}', "utf-8");

    // validatePath should accept it
    const validated = await fsA.validatePath(cfg);
    expect(validated).toBe(cfg);

    // get-file-stats should work
    const stats = await fsA.getFileStats(cfg);
    expect(stats.size).toBeGreaterThan(0);
  });
});

// ── AC6: Search isolation ───────────────────────────────────────────
describe("AC6 — search isolation", () => {
  test("user B's allowed dirs do not include user A's directory", async () => {
    const fsA = await fsFor(USER_A);
    const fsB = await fsFor(USER_B);

    const aRoot = fsA.getAllowedDirectories()[0];
    const bRoot = fsB.getAllowedDirectories()[0];

    // B's allowed dirs must not include A's root
    expect(bRoot).not.toEqual(aRoot);

    // Any path inside A's sandbox is denied for B
    const aFile = path.join(aRoot, "unique-token-xyz.txt");
    await fs.writeFile(aFile, "token-xyz-12345", "utf-8");

    await expect(fsB.validatePath(aFile)).rejects.toThrow(
      "Access denied"
    );

    // A can still access their own file
    const validated = await fsA.validatePath(aFile);
    expect(validated).toBe(aFile);
  });
});
