const { resolve, dirname } = require("path");
const { getPackageVersion } = require("../version.js");

const packageRoot = resolve(dirname(__filename), "../..");

describe("getPackageVersion", () => {
  test("returns the root package.json version", () => {
    const version = getPackageVersion(packageRoot);

    expect(version).toBeDefined();
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:[-+].*)?$/);
  });
});
