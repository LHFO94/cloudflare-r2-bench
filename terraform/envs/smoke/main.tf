/**
 * Smoke environment: one VM, three buckets, small keyspace.
 *
 * Exists to validate the whole path end to end - Worker deploy, D1 migrations,
 * agent boot, secret fetch, SigV4 signing, metrics reporting - for a few cents
 * and about five minutes, before committing to the standard run whose R2 Class B
 * charges dominate the cost.
 *
 * Deploy this first. Every failure mode this harness has is cheaper to find here.
 */
terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.23"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment.
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

module "stack" {
  source = "../../modules/stack"

  deployment_id = var.deployment_id
  repo_root     = abspath("${path.module}/../../..")

  cloudflare_account_id = var.cloudflare_account_id
  workers_dev_subdomain = var.workers_dev_subdomain
  r2_location           = "wnam"
  bucket_count          = 3
  # Small enough to seed in well under a minute while still exercising the
  # multi-bucket key derivation.
  keyspace = 2000

  gcp_project_id = var.gcp_project_id
  gcp_region     = var.gcp_region
  gcp_zones      = var.gcp_zones

  agent_count = 1
  # Two vCPU is plenty for a correctness check and keeps the smoke run off the
  # project's N2 quota headroom.
  machine_type      = "n2-standard-2"
  workers_per_agent = 64

  r2_access_key_id     = var.r2_access_key_id
  r2_secret_access_key = var.r2_secret_access_key

  labels = {
    env = "smoke"
  }
}
