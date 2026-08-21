SHELL := /bin/bash
.DEFAULT_GOAL := help

# Load .env and export everything in it, so every target below behaves the same
# regardless of which shell you are in or which terminal tab you last ran
# `export` in. Credentials live in .env (gitignored); .env.example is the
# template. Values must be unquoted - make would keep the quotes.
ifneq (,$(wildcard ./.env))
include .env
export
endif

DIST      := dist
AGENT_BIN := $(DIST)/agent-linux-amd64

# Which environment terraform targets act on. Override per invocation:
#   make tf-apply ENV=standard
ENV ?= smoke
TF  := terraform -chdir=terraform/envs/$(ENV)

# Reproducible-ish builds: -trimpath drops local paths, -s -w drop the symbol
# table and DWARF. The binary is copied to every VM at boot, so size matters
# more than the ability to run a debugger on it in production.
GO_LDFLAGS := -s -w
GO_BUILD   := CGO_ENABLED=0 go build -trimpath -ldflags '$(GO_LDFLAGS)'

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
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
# Deploy  (ENV=smoke by default; add ENV=standard for the full run)
# ---------------------------------------------------------------------------
.PHONY: preflight
preflight: ## Verify credentials and prerequisites before applying
	@./scripts/preflight.sh

.PHONY: tf-init
tf-init: ## terraform init for $(ENV)
	$(TF) init

.PHONY: tf-apply-r2
tf-apply-r2: ## Phase 1: create only the R2 buckets, so an R2 token can be scoped to them
	@# The R2 module ignores these, but Terraform still demands a value.
	TF_VAR_r2_access_key_id=$${TF_VAR_r2_access_key_id:-pending} \
	TF_VAR_r2_secret_access_key=$${TF_VAR_r2_secret_access_key:-pending} \
	$(TF) apply -target=module.stack.module.r2

.PHONY: tf-plan
tf-plan: preflight ## Plan the full stack for $(ENV)
	$(TF) plan

.PHONY: tf-apply
tf-apply: preflight build-agent ## Phase 2: apply the full stack for $(ENV)
	$(TF) apply

.PHONY: tf-destroy
tf-destroy: ## Destroy everything in $(ENV)
	$(TF) destroy

.PHONY: tf-destroy-vms
tf-destroy-vms: ## Destroy only the load generators, keeping buckets and seeded data
	$(TF) destroy -target=module.stack.module.loadgen

.PHONY: dashboard
dashboard: ## Print the operator URL, admin token included
	@$(TF) output -raw dashboard_url; echo

.PHONY: seed
seed: ## Populate the buckets (safe to re-run; skips already-seeded buckets)
	@set -a; eval "$$($(TF) output -raw seed_env)"; set +a; \
	  R2_ACCESS_KEY_ID="$$TF_VAR_r2_access_key_id" \
	  R2_SECRET_ACCESS_KEY="$$TF_VAR_r2_secret_access_key" \
	  go run ./cmd/seeder $(SEED_ARGS)

.PHONY: seed-dry-run
seed-dry-run: ## Report what seeding would write, and its Class A cost
	@$(MAKE) seed SEED_ARGS=-dry-run

.PHONY: agents
agents: ## List the running load-generator VMs
	@$(TF) output -raw list_instances_command | bash

# ---------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------
.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(DIST) wrangler.generated.jsonc
