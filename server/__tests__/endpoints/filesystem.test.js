const path = require("path");
const os = require("os");
const fs = require("fs");
const { Writable } = require("stream");

const SERVER_DIR = path.join(__dirname, "..", "..");

// system.js transitively imports heavy LLM provider stacks (AWS SDK, etc.)
// that are irrelevant to the read-only filesystem flow — stub updateENV so
// the endpoint module (validatedRequest → EncryptionManager → updateENV)
// loads in the test environment, mirroring requestToken.test.js.
jest.mock("../../utils/helpers/updateENV", () => ({
  updateENV: jest.fn(async () => ({ success: true, error: null })),
  dumpEnv: jest.fn(),
}));

/**
 * Tests for the read-only File Explorer endpoints:
 *   GET /filesystem/list
 *   GET /filesystem/read
 *
 * Same harness pattern as `requestToken.test.js` / `invite.test.js`:
 * instead of spinning up Express (whose bundled `send`/`mime` resolve to
 * ESM-only versions under jest and break `res.json`), we register the
 * routes on a fake `app`, capture the final handler, and invoke it directly
 * with mock request/response objects.
 *
 * The handlers run against **real** per-user sandbox directories (a
 * throwaway `STORAGE_DIR` under `os.tmpdir()`) created with `fs.mkdirSync`,
 * so the existing `FilesystemManager.validatePath()` security layer
 * (path traversal, symlink escape, cross-user isolation) is exercised
 * end-to-end — no DB, no auth middleware, no new test-only mocks of the
 * security-critical code under test.
 */

// The endpoint resolves the current user's sandbox via `userFromSession`
// (session/JWT lookup). In this harness there is no real HTTP session —
// we hand it `response.locals.user` directly, the same fast-path the real
// middleware uses after a successful login.
jest.mock("../../utils/http", () => ({
  userFromSession: jest.fn(async (request, response) => response?.locals?.user),
}));

const sandboxRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "totem-filesystem-endpoint-test-")
);

// `getFilesystemFor(userId)` resolves the sandbox root as
// `<STORAGE_DIR>/totemllm-fs/users/<userId>/` (see lib.js). Point it at
// our throwaway directory so no test ever touches a real user's files.
process.env.STORAGE_DIR = sandboxRoot;

const USER_A = { id: 1, username: "alice" };
const USER_B = { id: 2, username: "bob" };

const pathRootA = path.join(sandboxRoot, "totemllm-fs", "users", "1");
const pathRootB = path.join(sandboxRoot, "totemllm-fs", "users", "2");

// A file that lives OUTSIDE any user's sandbox — the symlink-escape
// target in one of the tests below.
const outsideFile = path.join(sandboxRoot, "outside-secret.txt");

/**
 * Creates the throwaway sandbox contents for user A:
 *
 *   1/ (rootA)
 *     hello.txt            small text file
 *     big.txt              > 1 MiB text file (truncation test)
 *     notes.md             markdown file
 *     blob.bin             small binary file (0x00..0x03)
 *     notes.md → notes.md  (not used)
 *     escape-link.txt → ../../outside-secret.txt  (symlink escape)
 *     docs/
 *       guide.md
 *     empty/               (empty directory)
 */
beforeAll(() => {
  fs.mkdirSync(pathRootA, { recursive: true });
  fs.mkdirSync(pathRootB, { recursive: true });
  fs.mkdirSync(path.join(pathRootA, "docs"), { recursive: true });
  fs.mkdirSync(path.join(pathRootA, "empty"), { recursive: true });

  fs.writeFileSync(path.join(pathRootA, "hello.txt"), "Hello, sandbox!\n");
  fs.writeFileSync(path.join(pathRootA, "notes.md"), "# Title\n\nSome **md**.\n");
  fs.writeFileSync(path.join(pathRootA, "docs", "guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(pathRootA, "blob.bin"), Buffer.from([0, 1, 2, 3]));

  // > 1 MiB text file for the truncation test.
  const bigSize = 2 * 1024 * 1024;
  const bigContent = "x".repeat(bigSize - 8) + "MARKER";
  fs.writeFileSync(path.join(pathRootA, "big.txt"), bigContent);

  // User B owns a file user A must never be able to read.
  fs.writeFileSync(path.join(pathRootB, "secret-b.txt"), "bob's secret\n");

  // A symlink INSIDE user A's sandbox that points OUTSIDE it.
  const linkPath = path.join(pathRootA, "escape-link.txt");
  fs.symlinkSync(path.join(sandboxRoot, "outside-secret.txt"), linkPath);
  fs.writeFileSync(outsideFile, "outside secret\n");

  // Capture the registered handlers via a fake Express app.
  const routes = [];
  const record =
    (method) =>
    (routePath, ...args) => {
      routes.push({ method, path: routePath, handler: args[args.length - 1] });
    };
  const fakeApp = {
    get: record("get"),
    post: record("post"),
    put: record("put"),
    delete: record("delete"),
    use: () => {},
  };

  const { filesystemEndpoints } = require("../../endpoints/filesystem");
  filesystemEndpoints(fakeApp);

  global.__fsHandlers = {
    list: routes.find((r) => r.path === "/filesystem/list" && r.method === "get"),
    read: routes.find((r) => r.path === "/filesystem/read" && r.method === "get"),
  };
  if (!global.__fsHandlers.list)
    throw new Error("GET /filesystem/list route not found");
  if (!global.__fsHandlers.read)
    throw new Error("GET /filesystem/read route not found");
});

afterAll(() => {
  if (sandboxRoot && fs.existsSync(sandboxRoot)) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/*  Mock request/response helpers                                       */
/* ------------------------------------------------------------------ */

function makeRequest({ path: p = "", raw = null } = {}) {
  const query = { ...(p !== undefined ? { path: p } : {}) };
  if (raw !== null) query.raw = raw;
  return { query, header: () => null };
}

function makeResponse(user) {
  // A real Writable so that stream.pipe(response) works end-to-end: pipe
  // calls .write()/.end() on the dest, and the Writable emits "finish" once
  // the source stream has fully flushed — which is what we await in callRead.
  const res = new Writable({
    write(chunk, _enc, cb) {
      res.chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  res.chunks = [];
  res.statusCode = 200; // Express defaults to 200 for .json()/.send()
  res.body = null;
  res.headers = {};
  res.locals = { user };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
    return res;
  };
  Object.defineProperty(res, "headersSent", {
    get: () => res.chunks.length > 0,
  });
  return res;
}

async function callList(user, p = "") {
  const request = makeRequest({ path: p });
  const response = makeResponse(user);
  await global.__fsHandlers.list.handler(request, response);
  return { status: response.statusCode, body: response.body };
}

async function callRead(user, p, { raw = null } = {}) {
  const request = makeRequest({ path: p, raw });
  const response = makeResponse(user);
  if (raw === "true") {
    // Attach BEFORE the handler runs so we never miss the "finish" event that
    // fires when stream.pipe(response) has fully flushed the file.
    response.once("finish", () => {});
  }
  await global.__fsHandlers.read.handler(request, response);
  if (raw === "true") {
    await new Promise((resolve) => {
      if (response.writableFinished) return resolve();
      response.once("finish", resolve);
    });
  }
  return {
    status: response.statusCode,
    body: response.body,
    headers: response.headers,
    rawBody: Buffer.concat(response.chunks),
  };
}

/* ------------------------------------------------------------------ */
/*  GET /filesystem/list                                                */
/* ------------------------------------------------------------------ */

describe("GET /filesystem/list", () => {
  it("lists the sandbox root with dirs-first, alphabetical ordering (F1)", async () => {
    const { status, body } = await callList(USER_A, "");
    expect(status).toBe(200);
    expect(body.path).toBe("");
    expect(Array.isArray(body.entries)).toBe(true);

    const names = body.entries.map((e) => e.name);
    // Dirs come before files (the two dirs: "docs", "empty").
    const dirIdx = names.map((n, i) =>
      body.entries[i].type === "dir" ? i : -1
    ).filter((i) => i >= 0);
    const fileIdx = names.map((n, i) =>
      body.entries[i].type === "file" ? i : -1
    ).filter((i) => i >= 0);
    if (dirIdx.length && fileIdx.length) {
      expect(Math.max(...dirIdx)).toBeLessThan(Math.min(...fileIdx));
    }

    // Both dirs present, both sorted alphabetically among themselves.
    const dirNames = body.entries.filter((e) => e.type === "dir").map((e) => e.name);
    expect(dirNames).toEqual(["docs", "empty"]);

    // Files present.
    expect(names).toContain("hello.txt");
    expect(names).toContain("notes.md");
    expect(names).toContain("blob.bin");
    expect(names).toContain("big.txt");
  });

  it("includes size/sizeFormatted/modified for files, null size for dirs (F1)", async () => {
    const { body } = await callList(USER_A, "");
    const hello = body.entries.find((e) => e.name === "hello.txt");
    expect(hello.type).toBe("file");
    expect(hello.size).toBeGreaterThan(0);
    expect(hello.sizeFormatted).toBeTruthy();
    expect(hello.modified).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    expect(hello.mime).toBe("text/plain");

    const docs = body.entries.find((e) => e.name === "docs");
    expect(docs.type).toBe("dir");
    expect(docs.size).toBeNull();
    expect(docs.mime).toBeNull();
  });

  it("lists an empty directory with zero entries (F2)", async () => {
    const { status, body } = await callList(USER_A, "empty");
    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
  });

  it("lists a subdirectory (F3)", async () => {
    const { status, body } = await callList(USER_A, "docs");
    expect(status).toBe(200);
    expect(body.entries.map((e) => e.name)).toEqual(["guide.md"]);
  });

  it("rejects path traversal with 403 (T6)", async () => {
    const { status } = await callList(USER_A, "../../..");
    expect(status).toBe(403);
  });

  it("rejects null bytes in the path with 400 (T5)", async () => {
    const { status } = await callList(USER_A, "bad\x00name");
    expect(status).toBe(400);
  });

  it("rejects a non-existent directory with 404 (T11)", async () => {
    const { status } = await callList(USER_A, "does-not-exist");
    expect(status).toBe(404);
  });

  it("is scoped to the requesting user's sandbox (T7)", async () => {
    // User B's sandbox root contains only secret-b.txt — never user A's files.
    const { status, body } = await callList(USER_B, "");
    expect(status).toBe(200);
    const names = body.entries.map((e) => e.name);
    expect(names).toEqual(["secret-b.txt"]);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /filesystem/read                                                */
/* ------------------------------------------------------------------ */

describe("GET /filesystem/read", () => {
  it("returns text file content with mime + size (T1)", async () => {
    const { status, body } = await callRead(USER_A, "hello.txt");
    expect(status).toBe(200);
    expect(body.path).toBe("hello.txt");
    expect(body.mime).toBe("text/plain");
    expect(body.size).toBeGreaterThan(0);
    expect(body.truncated).toBe(false);
    expect(body.content).toContain("Hello, sandbox!");
    expect(body.downloadUrl).toBeUndefined();
  });

  it("returns markdown files with mime text/markdown (F4b)", async () => {
    const { status, body } = await callRead(USER_A, "notes.md");
    expect(status).toBe(200);
    expect(body.mime).toBe("text/markdown");
    expect(body.content).toContain("# Title");
  });

  it("truncates files > 1 MiB and sets truncated: true (T2)", async () => {
    const { status, body } = await callRead(USER_A, "big.txt");
    expect(status).toBe(200);
    expect(body.truncated).toBe(true);
    // Content is capped at exactly MAX_TEXT_BYTES (1 MiB) — the tail marker
    // beyond the cap must NOT be present.
    expect(Buffer.byteLength(body.content, "utf-8")).toBeLessThanOrEqual(
      1024 * 1024
    );
    expect(body.content).not.toContain("MARKER");
  });

  it("returns 404 for a missing file (T3)", async () => {
    const { status } = await callRead(USER_A, "nope.txt");
    expect(status).toBe(404);
  });

  it("returns 400 when the path is a directory (T4)", async () => {
    const { status } = await callRead(USER_A, "docs");
    expect(status).toBe(400);
  });

  it("returns 400 when the required path parameter is missing", async () => {
    const request = makeRequest({ path: undefined });
    const response = makeResponse(USER_A);
    await global.__fsHandlers.read.handler(request, response);
    expect(response.statusCode).toBe(400);
  });

  it("rejects null bytes with 400", async () => {
    const { status } = await callRead(USER_A, "bad\x00name");
    expect(status).toBe(400);
  });

  it("returns a downloadUrl (not inline content) for binary files (T8)", async () => {
    const { status, body } = await callRead(USER_A, "blob.bin");
    expect(status).toBe(200);
    expect(body.content).toBeNull();
    expect(body.truncated).toBe(false);
    // blob.bin has no registered MIME → octet-stream fallback.
    expect(body.mime).toBe("application/octet-stream");
    expect(body.downloadUrl).toBe(
      `/api/filesystem/read?path=${encodeURIComponent("blob.bin")}&raw=true`
    );
  });

  it("streams raw bytes with correct headers for ?raw=true (T9)", async () => {
    const res = await callRead(USER_A, "hello.txt", { raw: "true" });
    expect(res.status).toBe(200); // no .status() override in the raw path
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.headers["content-length"]).toBe(String(res.rawBody.length));
    expect(res.headers["content-disposition"]).toMatch(/^inline; filename="hello\.txt"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawBody.toString("utf-8")).toContain("Hello, sandbox!");
  });

  it("rejects a symlink that escapes the sandbox with 403 (T10)", async () => {
    const { status } = await callRead(USER_A, "escape-link.txt");
    expect(status).toBe(403);
  });

  it("cannot read another user's file (cross-user isolation)", async () => {
    // secret-b.txt lives in user B's sandbox; from user A's perspective it
    // is simply not present → validatePath resolves it to a non-existent
    // path in A's sandbox → 404 (not 403, since the path is "inside" A's
    // sandbox; the file just isn't there).
    const { status } = await callRead(USER_A, "secret-b.txt");
    expect(status).toBe(404);
  });
});
