#!/usr/bin/env node
/**
 * setup-envs.mjs
 *
 * Cross-platform replacement for the `setup:envs` npm script.
 * Copies each *.env.example file to its target only if the target does not
 * already exist — equivalent to `cp -n` on POSIX systems.
 *
 * Works on Linux, macOS, and Windows.
 */

import { copyFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const pairs = [
  ["frontend/.env.example", "frontend/.env"],
  ["server/.env.example", "server/.env.development"],
  ["collector/.env.example", "collector/.env"],
  ["docker/.env.example", "docker/.env"],
];

for (const [src, dst] of pairs) {
  const srcPath = join(root, src);
  const dstPath = join(root, dst);
  if (!existsSync(srcPath)) {
    console.log(`  skip  ${dst}  (source not found: ${src})`);
    continue;
  }
  if (existsSync(dstPath)) {
    console.log(`  exists ${dst}`);
  } else {
    copyFileSync(srcPath, dstPath);
    console.log(`  copied ${dst}`);
  }
}

console.log("\nAll ENV files ready!\n");
