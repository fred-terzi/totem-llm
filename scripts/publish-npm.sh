#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Totem LLM — npm Publish Script
#
# Runs on the NPM BUILD MACHINE.
# Bumps version (optional), publishes to npm, and pushes the git tag.
#
# After this completes, run ./scripts/build-docker.sh on the docker machine.
#
# Usage:
#   ./scripts/publish-npm.sh              # auto-detect bump from commits
#   ./scripts/publish-npm.sh patch        # force patch bump (0.x.y → 0.x+1.0)
#   ./scripts/publish-npm.sh minor        # force minor bump (0.x.y → 0.x+1.0)
#   ./scripts/publish-npm.sh major        # force major bump
#   ./scripts/publish-npm.sh skip         # publish current version (no bump)
#
# Prerequisites:
#   - npm logged in:     npm login
#   - git user set:      git config user.name / user.email
#   - On a branch with commits to release (or use "skip" for re-publish)
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}${BOLD}▶${NC}  $*"; }
ok()    { echo -e "${GREEN}  ✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}  ⚠${NC}  $*"; }
err()   { echo -e "${RED}  ✗${NC}  $*"; echo; exit 1; }

# ── Determine version ───────────────────────────────────────────
BUMP_TYPE="${1:-auto}"

if [ "$BUMP_TYPE" = "skip" ]; then
    VERSION=$(node -p "require('./package.json').version")
    info "Skipping version bump. Publishing existing version: $VERSION"
else
    info "Running standard-version (bump: $BUMP_TYPE)..."

    if [ "$BUMP_TYPE" = "auto" ]; then
        npx standard-version
    else
        npx standard-version --release-as "$BUMP_TYPE"
    fi

    VERSION=$(node -p "require('./package.json').version")
    ok "New version: $VERSION"
fi

# ── Verify prerequisites ────────────────────────────────────────
echo ""
info "Verifying prerequisites..."

command -v npm > /dev/null 2>&1 || err "npm not found."
ok "npm: $(npm --version)"

NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 18 ] || err "Node >= 18 required. Current: $(node -v)"
ok "node: $(node -v)"

# Check npm auth
if ! npm whoami > /dev/null 2>&1; then
    err "Not logged into npm. Run: npm login"
fi
ok "npm user: $(npm whoami)"

# ── Verify version isn't already published ─────────────────────
EXISTING=$(npm view totem-llm@$VERSION version 2>/dev/null || echo "")
if [ -n "$EXISTING" ]; then
    err "totem-llm@$VERSION is already published on npm. Choose a different version or use a different bump type."
fi
ok "totem-llm@$VERSION is available (not yet published)"

# ── Run lint before publish ─────────────────────────────────────
echo ""
info "Running lint..."
yarn lint:ci
ok "Lint passed"

# ── Publish ─────────────────────────────────────────────────────
echo ""
info "Publishing totem-llm@$VERSION to npm..."
info "(prepublishOnly will build the frontend — this may take a minute)"

npm publish --access public

ok "Published totem-llm@$VERSION"

# ── Wait for propagation ────────────────────────────────────────
echo ""
info "Waiting for npm propagation (up to 30s)..."
for i in $(seq 1 6); do
    if npm view totem-llm@$VERSION version > /dev/null 2>&1; then
        ok "totem-llm@$VERSION is now visible on npm"
        break
    fi
    sleep 5
    if [ "$i" -eq 6 ]; then
        warn "npm propagation slow — the build-docker script has its own retry. Continue when ready."
    fi
done

# ── Push git tag ────────────────────────────────────────────────
if [ "$BUMP_TYPE" != "skip" ]; then
    echo ""
    info "Pushing commit + tag v$VERSION to origin..."
    git push origin HEAD
    git push origin "v$VERSION"
    ok "Tag v$VERSION pushed"
fi

# ── Done ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo -e "  ${GREEN}${BOLD}npm publish complete!${NC}"
echo "══════════════════════════════════════════════"
echo ""
echo "  npm:  totem-llm@$VERSION"
echo ""
echo "  Next step (on the Docker build machine):"
echo "    ./scripts/build-docker.sh $VERSION"
echo ""
