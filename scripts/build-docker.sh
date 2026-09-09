#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# Totem LLM — Docker Build & Push Script
#
# Runs on the DOCKER BUILD MACHINE (can be different from npm machine).
# Verifies the npm package is available, builds the image,
# runs a smoke test, and pushes to Docker Hub.
#
# Usage:
#   ./scripts/build-docker.sh 0.17.0       # build specific version
#   ./scripts/build-docker.sh latest       # build using @latest from npm
#   ./scripts/build-docker.sh 0.17.0 --skip-test   # skip smoke test
#   ./scripts/build-docker.sh 0.17.0 --no-push     # build only, don't push
#
# Prerequisites:
#   - docker logged in:  docker login
#   - npm package totem-llm@VERSION must be published
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

# ── Parse args ──────────────────────────────────────────────────
VERSION="${1:-latest}"
SKIP_TEST=false
NO_PUSH=false

for arg in "$@"; do
    case "$arg" in
        --skip-test) SKIP_TEST=true ;;
        --no-push)   NO_PUSH=true ;;
    esac
done

REGISTRY="docker.io"
IMAGE_NAME="fredterzi/totem-llm"
PLATFORM="linux/amd64"

# ── Verify prerequisites ────────────────────────────────────────
echo ""
info "Verifying prerequisites..."

command -v docker > /dev/null 2>&1 || err "docker not found."
ok "docker: $(docker --version | awk '{print $3}' | tr -d ',')"

docker info > /dev/null 2>&1 || err "Cannot connect to Docker daemon. Is it running?"
ok "Docker daemon: connected"

# Check Docker Hub login (skip if --no-push)
if [ "$NO_PUSH" = false ]; then
    docker info 2>/dev/null | grep -q "Username" || err "Not logged into Docker Hub. Run: docker login"
    ok "Docker Hub: logged in as $(docker info 2>/dev/null | grep Username | awk '{print $2}')"
fi

# ── Verify npm package is available ─────────────────────────────
echo ""
info "Verifying npm package (totem-llm@$VERSION)..."

if [ "$VERSION" = "latest" ]; then
    # Just verify the package exists at all
    if ! npm view totem-llm version > /dev/null 2>&1; then
        err "Package 'totem-llm' not found on npm. Run ./scripts/publish-npm.sh first."
    fi
    LATEST=$(npm view totem-llm version 2>/dev/null)
    ok "totem-llm@latest → $LATEST"
else
    # Retry loop — npm propagation can take up to 60s
    FOUND=false
    for i in $(seq 1 12); do
        if npm view totem-llm@$VERSION version > /dev/null 2>&1; then
            FOUND=true
            break
        fi
        if [ "$i" -lt 12 ]; then
            echo "  Not yet visible… retrying ($i/12)"
            sleep 5
        fi
    done

    if [ "$FOUND" = false ]; then
        err "totem-llm@$VERSION not found on npm after 60s. "
        err "Run ./scripts/publish-npm.sh $VERSION on the npm machine first."
    fi
    ok "totem-llm@$VERSION is available on npm"
fi

# ── Build ───────────────────────────────────────────────────────
echo ""
info "Building Docker image ($IMAGE_NAME:$VERSION)..."

docker build \
    --platform "$PLATFORM" \
    -f docker/Dockerfile \
    --build-arg TOTEM_LLM_VERSION="$VERSION" \
    -t "$IMAGE_NAME:$VERSION" \
    -t "$IMAGE_NAME:latest" \
    .

# Show image size
IMAGE_SIZE=$(docker image inspect "$IMAGE_NAME:$VERSION" --format '{{.Size}}' 2>/dev/null || echo "0")
IMAGE_SIZE_HUMAN=$(numfmt --to=iec "$IMAGE_SIZE" 2>/dev/null || echo "${IMAGE_SIZE} bytes")
ok "Built: $IMAGE_NAME:$VERSION (${IMAGE_SIZE_HUMAN})"

# ── Smoke test ──────────────────────────────────────────────────
if [ "$SKIP_TEST" = false ]; then
    echo ""
    info "Smoke test (starting container on port 18686)..."

    docker run -d --name totem-smoke-test -p 18686:8686 "$IMAGE_NAME:$VERSION"

    SMOKE_OK=false
    SMOKE_MAX_WAIT=180  # 180s max — allows model pull on first run (~6GB at 50MB/s)
    SMOKE_ELAPSED=0
    while [ "$SMOKE_ELAPSED" -lt "$SMOKE_MAX_WAIT" ]; do
        if curl -s --max-time 2 http://localhost:18686/api/ping > /dev/null 2>&1; then
            SMOKE_OK=true
            break
        fi
        sleep 2
        SMOKE_ELAPSED=$((SMOKE_ELAPSED + 2))
    done

    if [ "$SMOKE_OK" = true ]; then
        PING=$(curl -s http://localhost:18686/api/ping)
        ok "Smoke test passed (health: $PING)"
    else
        warn "Smoke test timed out — checking logs..."
        docker logs totem-smoke-test 2>&1 | tail -30
        docker stop totem-smoke-test > /dev/null 2>&1
        docker rm totem-smoke-test > /dev/null 2>&1
        err "Smoke test failed"
    fi

    docker stop totem-smoke-test > /dev/null 2>&1
    docker rm totem-smoke-test > /dev/null 2>&1
else
    echo ""
    info "Skipping smoke test (--skip-test)"
fi

# ── Push ────────────────────────────────────────────────────────
if [ "$NO_PUSH" = false ]; then
    echo ""
    info "Pushing to Docker Hub..."

    docker push "$IMAGE_NAME:$VERSION"
    docker push "$IMAGE_NAME:latest"

    ok "Pushed:"
    ok "  $IMAGE_NAME:$VERSION"
    ok "  $IMAGE_NAME:latest"
else
    echo ""
    info "Skipping push (--no-push)"
fi

# ── Done ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo -e "  ${GREEN}${BOLD}Docker build complete!${NC}"
echo "══════════════════════════════════════════════"
echo ""
echo "  Image:     $IMAGE_NAME:$VERSION"
echo "  Docker:    docker pull $IMAGE_NAME:$VERSION"
echo ""
if [ "$NO_PUSH" = false ]; then
    echo "  RunPod template → update image to: $IMAGE_NAME:$VERSION"
    echo "  (or keep pointing at :latest for auto-updates)"
    echo ""
fi
