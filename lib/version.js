import { readFileSync } from "fs";
import { join } from "path";

export function getPackageVersion(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  const raw = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw);

  if (!pkg?.version) {
    throw new Error(`Version not found in ${packageJsonPath}`);
  }

  return pkg.version;
}
