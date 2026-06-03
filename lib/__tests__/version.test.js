import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getPackageVersion } from "../version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "../..");

describe("getPackageVersion", () => {
  test("returns the root package.json version", () => {
    const version = getPackageVersion(packageRoot);

    expect(version).toBeDefined();
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
  });
});
