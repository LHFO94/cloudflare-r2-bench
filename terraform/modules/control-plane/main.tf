terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.23"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

locals {
  # Kept in step with the checked-in wrangler.jsonc so local dev and deployed
  # environments run against the same runtime semantics.
  compatibility_date = "2026-08-06"

  generated_config = "${var.repo_root}/wrangler.generated.jsonc"
  worker_url       = "https://${var.worker_name}.${var.workers_dev_subdomain}.workers.dev"

  # Redeploy when the Worker source or its static assets change. Hashing the
  # files is what makes `terraform apply` idempotent: a timestamp trigger would
  # redeploy on every run, and no trigger at all would silently ship stale code.
  # Migrations are excluded here because terraform_data.migrations tracks them
  # and the deploy depends on it.
  source_hash = sha256(join("", concat(
    [for f in sort(tolist(fileset("${var.repo_root}/src", "**/*.ts"))) : filesha256("${var.repo_root}/src/${f}")],
    [for f in sort(tolist(fileset("${var.repo_root}/assets", "**"))) : filesha256("${var.repo_root}/assets/${f}")],
  )))
}

# ---------------------------------------------------------------------------
# Shared tokens
# ---------------------------------------------------------------------------
# AGENT_TOKEN authenticates load generators; ADMIN_TOKEN gates job control.
# They are separate so that a VM image leaking its metadata does not also hand
# out the ability to start and stop runs.
#
# Both land in Terraform state. That is acceptable here because they only grant
# access to a disposable benchmark control plane, but it is the reason the R2
# credentials are deliberately kept out of Terraform entirely (see the
# loadgen-pool module).
resource "random_password" "agent_token" {
  length  = 48
  special = false
}

resource "random_password" "admin_token" {
  length  = 48
  special = false
}

# ---------------------------------------------------------------------------
# Cloudflare Access service token
# ---------------------------------------------------------------------------
# Cloudflare can protect a Worker's workers.dev URL with Access, either per
# Worker or account-wide ("protect all Workers by default"). That protection is
# attached to the Worker rather than to a hostname, so it does not appear as an
# Access application and it reappears on every fresh deployment of this stack.
#
# Access rejects unauthenticated requests at the edge with a redirect to its
# login page, before the Worker runs. A browser follows that and signs in; a
# load generator cannot. A service token is the supported machine credential.
#
# Created unconditionally: it costs nothing when Access is not enabled, and
# provisioning it only on demand would mean discovering the need after a fleet
# is already up and failing.
resource "cloudflare_zero_trust_access_service_token" "agents" {
  count = var.create_access_service_token ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = "${var.worker_name}-agents"

  # Must outlast the benchmark run. Rotation is a redeploy, which also rolls
  # the fleet, so there is no partial-rotation window to worry about.
  duration = var.access_service_token_duration
}

# ---------------------------------------------------------------------------
# Metrics store
# ---------------------------------------------------------------------------
resource "cloudflare_d1_database" "metrics" {
  account_id            = var.cloudflare_account_id
  name                  = var.worker_name
  primary_location_hint = var.d1_location_hint

  # Must be stated explicitly. The API always reports a value here, so leaving
  # it out of the configuration is read as "set this to null", and the provider
  # then sends null on update, which the API rejects:
  #
  #   400 Invalid property: read_replication => Expected object, received null
  #
  # That turns every subsequent apply into a hard failure, not just the one
  # that changes something about D1.
  #
  # "disabled" is also the behaviour this benchmark wants: replicas would serve
  # stale reads to the watch page while a run is in flight, and every write
  # here comes from agents reporting metrics rather than from readers.
  read_replication = {
    mode = "disabled"
  }
}

# ---------------------------------------------------------------------------
# Worker deployment
# ---------------------------------------------------------------------------
# The Worker is deployed by wrangler rather than by the Cloudflare provider:
# wrangler owns the asset upload, source-map upload and D1 migration flow, and
# reimplementing those as provider resources would drift from what `npm run
# deploy` does locally.
resource "local_file" "wrangler_config" {
  filename        = local.generated_config
  file_permission = "0644"

  content = templatefile("${path.module}/wrangler.jsonc.tftpl", {
    worker_name        = var.worker_name
    compatibility_date = local.compatibility_date
    r2_account_id      = var.r2_account_id
    d1_database_name   = cloudflare_d1_database.metrics.name
    d1_database_id     = cloudflare_d1_database.metrics.uuid
    agent_count        = var.agent_count
  })
}

resource "terraform_data" "migrations" {
  triggers_replace = {
    database_id = cloudflare_d1_database.metrics.uuid
    migrations  = sha256(join("", [for f in sort(tolist(fileset("${var.repo_root}/migrations", "*.sql"))) : filesha256("${var.repo_root}/migrations/${f}")]))
  }

  provisioner "local-exec" {
    working_dir = var.repo_root
    command     = "${var.wrangler_command} d1 migrations apply DB --remote --config '${local.generated_config}'"

    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      # Non-interactive so a missing confirmation prompt fails the apply rather
      # than hanging Terraform forever.
      CI = "1"
    }
  }

  depends_on = [local_file.wrangler_config]
}

resource "terraform_data" "deploy" {
  triggers_replace = {
    worker_name = var.worker_name
    config      = local_file.wrangler_config.content_sha256
    sources     = local.source_hash
  }

  provisioner "local-exec" {
    working_dir = var.repo_root
    command     = "${var.wrangler_command} deploy --config '${local.generated_config}'"

    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      CI                    = "1"
    }
  }

  depends_on = [terraform_data.migrations]
}

# Secrets are set after deploy: `wrangler secret put` requires the script to
# exist. There is no Worker-secret resource in cloudflare provider v5, so this
# is the supported path.
resource "terraform_data" "secrets" {
  triggers_replace = {
    deploy      = terraform_data.deploy.id
    agent_token = sha256(random_password.agent_token.result)
    admin_token = sha256(random_password.admin_token.result)
  }

  provisioner "local-exec" {
    working_dir = var.repo_root
    interpreter = ["/bin/bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      printf '%s' "$AGENT_TOKEN" | ${var.wrangler_command} secret put AGENT_TOKEN --config '${local.generated_config}'
      printf '%s' "$ADMIN_TOKEN" | ${var.wrangler_command} secret put ADMIN_TOKEN --config '${local.generated_config}'
    EOT

    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      CI                    = "1"
      AGENT_TOKEN           = random_password.agent_token.result
      ADMIN_TOKEN           = random_password.admin_token.result
    }
  }
}
