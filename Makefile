# ──────────────────────────────────────────────────────────────────
# Totem LLM — Makefile
# Convenience targets for Docker build/test/push
# ──────────────────────────────────────────────────────────────────

IMAGE_NAME  ?= fred-terzi/totem-llm
VERSION     ?= latest
PLATFORM    ?= linux/amd64
GPU         ?= --gpus all

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ── Release pipeline (two-machine) ──────────────────────────────

.PHONY: npm-publish
npm-publish: ## [NPM machine] Bump version + publish to npm
	./scripts/publish-npm.sh $(VERSION)

.PHONY: npm-publish-patch
npm-publish-patch: ## [NPM machine] Publish with patch bump
	./scripts/publish-npm.sh patch

.PHONY: npm-publish-minor
npm-publish-minor: ## [NPM machine] Publish with minor bump
	./scripts/publish-npm.sh minor

.PHONY: npm-publish-major
npm-publish-major: ## [NPM machine] Publish with major bump
	./scripts/publish-npm.sh major

# ── Docker build (docker machine) ────────────────────────────────

.PHONY: docker-build
docker-build: ## [DOCKER machine] Build image (VERSION=0.17.0 or latest)
	./scripts/build-docker.sh $(VERSION)

.PHONY: docker-build-nopush
docker-build-nopush: ## [DOCKER machine] Build only, don't push
	./scripts/build-docker.sh $(VERSION) --no-push --skip-test

.PHONY: docker-build-skiptest
docker-build-skiptest: ## [DOCKER machine] Build + push, skip smoke test
	./scripts/build-docker.sh $(VERSION) --skip-test

# ── Local development ───────────────────────────────────────────

.PHONY: docker-test
docker-test: ## Run a quick smoke test (no GPU)
	@echo "▶ Starting smoke test..."
	docker run -d --name totem-smoke -p 18686:8686 $(IMAGE_NAME):$(VERSION)
	@for i in $$(seq 1 45); do \
		if curl -s --max-time 2 http://localhost:18686/api/ping > /dev/null 2>&1; then \
			echo "  ✓ Totem LLM is responding: $$(curl -s http://localhost:18686/api/ping)"; \
			break; \
		fi; \
		if [ $$i -eq 45 ]; then \
			echo "  ✗ Timed out. Logs:"; \
			docker logs totem-smoke 2>&1 | tail -30; \
			docker stop totem-smoke; docker rm totem-smoke; \
			exit 1; \
		fi; \
		sleep 2; \
	done
	docker stop totem-smoke > /dev/null 2>&1
	docker rm totem-smoke > /dev/null 2>&1
	@echo "  ✓ Smoke test passed"

.PHONY: docker-run
docker-run: ## Run interactively with GPU (Ctrl+C to stop)
	docker run --rm -it \
		$(GPU) \
		-p 8686:8686 \
		-p 11434:11434 \
		$(IMAGE_NAME):$(VERSION)

.PHONY: docker-run-cpu
docker-run-cpu: ## Run interactively without GPU (CPU mode)
	docker run --rm -it \
		-p 8686:8686 \
		-p 11434:11434 \
		$(IMAGE_NAME):$(VERSION)

# ── Utilities ───────────────────────────────────────────────────

.PHONY: docker-logs
docker-logs: ## Tail logs of running container
	docker logs -f totem

.PHONY: docker-clean
docker-clean: ## Remove the local image
	docker rmi $(IMAGE_NAME):$(VERSION) 2>/dev/null || true
	docker rmi $(IMAGE_NAME):latest 2>/dev/null || true
	@echo "✓ Removed local image"

.PHONY: docker-ollama-list
docker-ollama-list: ## List models in a running container
	docker exec totem ollama list

.PHONY: docker-ollama-pull
docker-ollama-pull: ## Pull a model into running container (MODEL=qwen3.8:27b)
	@test -n "$(MODEL)" || (echo "Usage: make docker-ollama-pull MODEL=qwen3.8:27b"; exit 1)
	docker exec totem ollama pull $(MODEL)
	@echo "✓ Pulled $(MODEL)"

.PHONY: docker-exec
docker-exec: ## Shell into running container (CMD=bash)
	docker exec -it totem $(CMD)
