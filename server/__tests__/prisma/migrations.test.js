const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

const SERVER_DIR = path.join(__dirname, "..", "..");
const MIGRATION = "20261016083000_add_user_email";

/**
 * Migration test for `add_user_email`.
 *
 * Applies the full migration history onto a throwaway SQLite database (in
 * os.tmpdir()) and asserts the resulting `users` table shape. A temp file
 * is used (not `:memory:`) because the prisma CLI opens its own connection
 * in a child process — an in-memory DB would not be shared across processes.
 */
describe(`migration ${MIGRATION}`, () => {
  let prisma;
  let tmpDir;
  let dbUrl;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "totem-migration-test-"));
    dbUrl = `file:${path.join(tmpDir, "test.db")}`;

    execSync(
      `npx prisma migrate deploy --schema ${path.join(
        SERVER_DIR,
        "prisma",
        "schema.prisma"
      )}`,
      {
        cwd: SERVER_DIR,
        env: { ...process.env, DATABASE_URL: dbUrl },
        stdio: "pipe",
      }
    );

    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient({
      datasources: { db: { url: dbUrl } },
      log: [],
    });
  }, 120000);

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a users table with a nullable email column", async () => {
    const user = await prisma.users.create({
      data: { username: "alice", password: "hash" },
    });
    expect(user.email).toBeNull();
  });

  it("accepts an email address on a user", async () => {
    const user = await prisma.users.create({
      data: { username: "bob", password: "hash", email: "bob@example.com" },
    });
    expect(user.email).toBe("bob@example.com");
  });

  it("allows many users without an email (uniqueness is nullable)", async () => {
    await prisma.users.create({
      data: { username: "carol", password: "hash" },
    });
    const count = await prisma.users.count({ where: { email: null } });
    expect(count).toBeGreaterThanOrEqual(2); // alice + carol
  });

  it("enforces uniqueness of non-null email values (P2002)", async () => {
    await expect(
      prisma.users.create({
        data: { username: "dave", password: "hash", email: "bob@example.com" },
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("still enforces uniqueness of usernames after the migration", async () => {
    await expect(
      prisma.users.create({
        data: { username: "alice", password: "other" },
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
