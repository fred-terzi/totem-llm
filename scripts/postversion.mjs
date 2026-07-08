#!/usr/bin/env node
// scripts/postversion.mjs - Post-standard-version hook.
// Runs after version is bumped in package.json by standard-version.
// Commits the bump and pushes both code + tag.
import { execSync } from 'node:child_process';

try {
  // Stage bump
  console.log('[postversion] staging package.json...');
  execSync('git add package.json', { stdio: 'inherit' });

  // Commit with the same message standard-version would use
  const pkg = JSON.parse(
    new TextDecoder().decode(execSync('cat package.json'))
  );
  console.log(`[postversion] committing v${pkg.version}...`);
  execSync(`git commit -m "chore: bump version to ${pkg.version}" --no-verify`, { stdio: 'inherit' });

  // Push commit + tag (tag already created by standard-version)
  console.log('[postversion] pushing...');
  execSync('git push', { stdio: 'inherit' });
  console.log(`[postversion] v${pkg.version} released!`);
} catch (err) {
  // If push fails (e.g., detached HEAD), leave the tag but don't fail
  console.warn('[postversion] push failed, version bump committed locally:', err.message);
}
