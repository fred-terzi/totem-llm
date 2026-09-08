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
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: docker-build
docker-build: ## Build the Docker image (VERSION=latest by default)
	docker build \
		--platform $(PLATFORM) \
		-f docker/Dockerfile \
		--build-arg TOTEM_LLM_VERSION=$(VERSION) \
		-t $(IMAGE_NAME):$(VERSION) \
		-t $(IMAGE_NAME):latest \
		.

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

.PHONY: docker-logs
docker-logs: ## Tail logs of running container
	docker logs -f totem

.PHONY: docker-push
docker-push: ## Push to Docker Hub (requires: docker login)
	docker push $(IMAGE_NAME):$(VERSION)
	docker push $(IMAGE_NAME):latest
	@echo "✓ Pushed $(IMAGE_NAME):$(VERSION) + :latest to Docker Hub"

.PHONY: docker-release
docker-release: ## Full release: version bump → npm publish → docker build → push
	./scripts/release-docker.sh $(VERSION)

.PHONY: docker-release-patch
docker-release-patch: ## Release patch version
	./scripts/release-docker.sh patch

.PHONY: docker-release-minor
docker-release-minor: ## Release minor version
	./scripts/release-docker.sh minor

.PHONY: docker-release-major
docker-release-major: ## Release major version
	./scripts/release-docker.sh major

.PHONY: docker-clean
docker-clean: ## Remove the local image
	docker rmi $(IMAGE_NAME):$(VERSION) 2>/dev/null || true
	docker rmi $(IMAGE_NAME):latest 2>/dev/null || true
	@echo "✓ Removed local image"

.PHONY: docker-pull-models
docker-pull-models: ## List models in the running container
	docker exec totem ollama list

.PHONY: docker-pull-model
docker-pull-model: ## Pull a model into the running container (MODEL=llama3.1:8b)
	@test -n "$(MODEL)" || (echo "Usage: make docker-pull-model MODEL=llama3.1:8b"; exit 1)
	docker exec totem ollama pull $(MODEL)
	@echo "✓ Pulled $(MODEL)"
