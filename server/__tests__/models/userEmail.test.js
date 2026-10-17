const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync } = require("child_process");

const SERVER_DIR = path.join(__dirname, "..", "..");

/**
 * Email validation is a pure function — test it in isolation with no DB.
 */
describe("User.validations.email", () => {
  // require() runs the model file; no DB access happens until prisma is used.
  const { User } = require("../../models/user");

  it("returns null for null/undefined/empty values (email is optional)", () => {
    expect(User.validations.email(null)).toBeNull();
    expect(User.validations.email(undefined)).toBeNull();
    expect(User.validations.email("")).toBeNull();
    expect(User.validations.email("   ")).toBeNull();
  });

  it("normalizes to lowercase and trims surrounding whitespace", () => {
    expect(User.validations.email("Alice@Example.COM")).toBe(
      "alice@example.com"
    );
    expect(User.validations.email("  bob@example.com  ")).toBe(
      "bob@example.com"
    );
    expect(User.validations.email(" user@example.com")).toBe(
      "user@example.com"
    );
  });

  it("accepts valid email addresses", () => {
    expect(User.validations.email("a@b.co")).toBe("a@b.co");
    expect(User.validations.email("user.name+tag@sub.domain.org")).toBe(
      "user.name+tag@sub.domain.org"
    );
    expect(User.validations.email("123@456.com")).toBe("123@456.com");
    expect(User.validations.email("first-last@my-domain.net")).toBe(
      "first-last@my-domain.net"
    );
  });

  it("rejects malformed email addresses", () => {
    const invalid = [
      "no-at-sign",
      "user@",
      "@example.com",
      "user@.com",
      "user@localhost", // no dotted domain
      "user@domain", // no TLD dot
      "a@b@c.com",
    ];
    // (Note: surrounding whitespace is trimmed by the validator, not an error.)
    invalid.forEach((value) => {
      expect(() => User.validations.email(value)).toThrow(
        "A valid email address is required"
      );
    });
  });

  it("accepts an email of exactly 254 characters (RFC 5321 limit)", () => {
    const local = "a".repeat(254 - "@example.com".length);
    const email = `${local}@example.com`;
    expect(email.length).toBe(254);
    expect(User.validations.email(email)).toBe(email);
  });

  it("rejects emails longer than 254 characters", () => {
    const local = "a".repeat(255 - "@example.com".length);
    expect(() => User.validations.email(`${local}@example.com`)).toThrow(
      "Email cannot be longer than 254 characters"
    );
  });
});

/**
 * Integration: User.create() with email + User.getByUsernameOrEmail()
 * against a throwaway SQLite DB (full migration history applied).
 */
describe("User model email support (integration)", () => {
  let tmpDir;
  let dbUrl;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "totem-user-email-test-"));
    dbUrl = `file:${path.join(tmpDir, "test.db")}`;

    // The prisma client singleton reads DATABASE_URL at first use — set it
    // before the model (and its prisma dep) is required below.
    process.env.DATABASE_URL = dbUrl;

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
  }, 120000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Lazy-require AFTER DATABASE_URL is set (module cache is process-wide).
  const { User } = require("../../models/user");
  const prisma = require("../../utils/prisma");

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates a user with an email address", async () => {
    const { user, error } = await User.create({
      username: "emailuser",
      password: "Str0ngPass!",
      email: "EmailUser@Example.com",
    });
    expect(error).toBeNull();
    expect(user.username).toBe("emailuser");
    expect(user.email).toBe("emailuser@example.com"); // normalized lowercase
  });

  it("creates a user without an email (backward compatible)", async () => {
    const { user, error } = await User.create({
      username: "noemailuser",
      password: "Str0ngPass!",
    });
    expect(error).toBeNull();
    expect(user.email).toBeNull();
  });

  it("rejects an invalid email on create", async () => {
    const { user, error } = await User.create({
      username: "bademail",
      password: "Str0ngPass!",
      email: "not-an-email",
    });
    expect(user).toBeNull();
    expect(error).toBe("A valid email address is required");
  });

  it("rejects a duplicate email with a friendly P2002 message", async () => {
    const { user, error } = await User.create({
      username: "otheruser",
      password: "Str0ngPass!",
      email: "emailuser@example.com",
    });
    expect(user).toBeNull();
    expect(error).toBe("A user with that email already exists");
  });

  it("finds a user by username", async () => {
    const user = await User.getByUsernameOrEmail("emailuser");
    expect(user).not.toBeNull();
    expect(user.username).toBe("emailuser");
    expect(user.email).toBe("emailuser@example.com");
  });

  it("finds a user by email (case-insensitive)", async () => {
    const user = await User.getByUsernameOrEmail("EMAILUSER@EXAMPLE.COM");
    expect(user).not.toBeNull();
    expect(user.username).toBe("emailuser");
  });

  it("returns null for unknown identifiers", async () => {
    expect(await User.getByUsernameOrEmail("ghost")).toBeNull();
    expect(await User.getByUsernameOrEmail("ghost@example.com")).toBeNull();
    expect(await User.getByUsernameOrEmail("")).toBeNull();
    expect(await User.getByUsernameOrEmail(null)).toBeNull();
  });
});
