SHELL := /bin/bash
.DEFAULT_GOAL := help

DIST      := dist
AGENT_BIN := $(DIST)/agent-linux-amd64

# Reproducible-ish builds: -trimpath drops local paths, -s -w drop the symbol
# table and DWARF. The binary is copied to every VM at boot, so size matters
# more than the ability to run a debugger on it in production.
GO_LDFLAGS := -s -w
GO_BUILD   := CGO_ENABLED=0 go build -trimpath -ldflags '$(GO_LDFLAGS)'

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
.PHONY: build-agent
build-agent: $(AGENT_BIN) ## Cross-compile the load agent for the GCP VMs

$(AGENT_BIN): $(shell find cmd/agent internal -name '*.go') go.mod
	@mkdir -p $(DIST)
	GOOS=linux GOARCH=amd64 $(GO_BUILD) -o $(AGENT_BIN) ./cmd/agent
	@echo "built $(AGENT_BIN) ($$(du -h $(AGENT_BIN) | cut -f1))"

.PHONY: build
build: build-agent ## Build everything Terraform needs

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
.PHONY: test
test: test-go test-worker ## Run every test suite

.PHONY: test-go
test-go: ## Go unit tests, with the race detector
	gofmt -l . | (! grep .) || (echo "run gofmt -w ."; exit 1)
	go vet ./...
	go test -race ./...

.PHONY: test-worker
test-worker: ## Worker tests and type checks
	npx tsc --noEmit -p tsconfig.json
	npx tsc --noEmit -p test/tsconfig.json
	npx vitest run

.PHONY: test-terraform
test-terraform: ## Terraform formatting and validation
	terraform -chdir=terraform fmt -recursive -check
	terraform -chdir=terraform/envs/smoke init -backend=false -input=false >/dev/null
	terraform -chdir=terraform/envs/smoke validate
	terraform -chdir=terraform/envs/standard init -backend=false -input=false >/dev/null
	terraform -chdir=terraform/envs/standard validate

.PHONY: check
check: test test-terraform ## Everything CI would run

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------
.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(DIST) wrangler.generated.jsonc
