#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Totem LLM — Docker Release Script
#
# Orchestrates the full release pipeline:
#   1. standard-version (bump + changelog + tag)
#   2. npm publish
#   3. docker build
#   4. docker push to Docker Hub
#
# Usage:
#   ./scripts/release-docker.sh            # auto-detect bump from commits
#   ./scripts/release-docker.sh patch      # force patch bump
#   ./scripts/release-docker.sh minor      # force minor bump
#   ./scripts/release-docker.sh major      # force major bump
#   ./scripts/release-docker.sh skip       # skip version bump (re-publish only)
#
# Prerequisites:
#   - docker logged in:  docker login
#   - npm logged in:     npm login
#   - git user set:      git config user.name / user.email
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
    # Read current version from package.json
    VERSION=$(node -p "require('./package.json').version")
    info "Skipping version bump. Publishing existing version: $VERSION"
else
    info "Running standard-version (bump: $BUMP_TYPE)..."

    if [ "$BUMP_TYPE" = "auto" ]; then
        npx standard-version
    else
        npx standard-version --release-as "$BUMP_TYPE"
    fi

    # Read the new version
    VERSION=$(node -p "require('./package.json').version")
    ok "Version: $VERSION"
fi

# ── Verify prerequisites ────────────────────────────────────────
echo ""
info "Verifying prerequisites..."

# Docker
command -v docker > /dev/null 2>&1 || err "docker not found. Install Docker Desktop or CLI."
ok "docker: $(docker --version | awk '{print $3}' | tr -d ',')"

# Check Docker Hub login
docker info 2>/dev/null | grep -q "Username" || warn "Not logged into Docker Hub. Run: docker login"

# npm
command -v npm > /dev/null 2>&1 || err "npm not found."
ok "npm: $(npm --version)"

# Node
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 18 ] || err "Node >= 18 required. Current: $(node -v)"
ok "node: $(node -v)"

# ── Step 1: Publish npm package ─────────────────────────────────
echo ""
info "Step 1/4: Publishing totem-llm@$VERSION to npm..."

# Check if already published
EXISTING=$(npm view totem-llm@$VERSION version 2>/dev/null || echo "")
if [ -n "$EXISTING" ]; then
    warn "totem-llm@$VERSION already exists on npm. Skipping publish."
else
    # prepublishOnly builds the frontend
    npm publish --access public
    ok "Published totem-llm@$VERSION"
fi

# ── Step 2: Build Docker image ──────────────────────────────────
echo ""
info "Step 2/4: Building Docker image (totem-llm:$VERSION)..."

docker build \
    --platform linux/amd64 \
    -f docker/Dockerfile \
    --build-arg TOTEM_LLM_VERSION="$VERSION" \
    -t "fred-terzi/totem-llm:$VERSION" \
    -t "fred-terzi/totem-llm:latest" \
    .

ok "Built: fred-terzi/totem-llm:$VERSION"

# ── Step 3: Quick smoke test ────────────────────────────────────
echo ""
info "Step 3/4: Smoke test..."

docker run -d --name totem-smoke-test -p 18686:8686 "fred-terzi/totem-llm:$VERSION"

# Wait for health
SMOKE_OK=false
for i in $(seq 1 45); do
    if curl -s --max-time 2 http://localhost:18686/api/ping > /dev/null 2>&1; then
        SMOKE_OK=true
        break
    fi
    sleep 2
done

if [ "$SMOKE_OK" = true ]; then
    PING=$(curl -s http://localhost:18686/api/ping)
    ok "Smoke test passed (health: $PING)"
else
    warn "Smoke test timed out — checking logs..."
    docker logs totem-smoke-test 2>&1 | tail -30
fi

docker stop totem-smoke-test > /dev/null 2>&1
docker rm totem-smoke-test > /dev/null 2>&1

# ── Step 4: Push to Docker Hub ──────────────────────────────────
echo ""
info "Step 4/4: Pushing to Docker Hub..."

docker push "fred-terzi/totem-llm:$VERSION"
docker push "fred-terzi/totem-llm:latest"

ok "Pushed to Docker Hub:"
ok "  fred-terzi/totem-llm:$VERSION"
ok "  fred-terzi/totem-llm:latest"

# ── Push git tag ─────────────────────────────────────────────────
if [ "$BUMP_TYPE" != "skip" ]; then
    echo ""
    info "Pushing git tag v$VERSION..."
    git push origin "v$VERSION"
    ok "Tag pushed"
fi

# ── Done ─────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo -e "  ${GREEN}${BOLD}Release complete!${NC}"
echo "══════════════════════════════════════════════"
echo ""
echo "  npm:       totem-llm@$VERSION"
echo "  docker:    fred-terzi/totem-llm:$VERSION"
echo "  docker:    fred-terzi/totem-llm:latest"
echo ""
echo "  Test locally:"
echo "    docker run --rm -it --gpus all -p 8686:8686 fred-terzi/totem-llm:$VERSION"
echo ""
echo "  RunPod template already points at :latest —"
echo "  new deployments will pick up this version automatically."
echo ""
