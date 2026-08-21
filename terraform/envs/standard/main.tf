/**
 * Standard environment: the full 80,000 RPS run.
 *
 * 8 x n2-standard-8 in us-west2 against 25 R2 buckets in "wnam".
 * ~10,000 RPS per VM of ~1.5 KB objects, roughly 1.2 Gbps of aggregate ingress,
 * which is an order of magnitude below the per-VM ingress ceiling. The fleet is
 * sized for CPU headroom on TLS and syscalls, not for bandwidth.
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
  # Reads CLOUDFLARE_API_TOKEN from the environment. Never put the token in a
  # tfvars file: it would end up in version control or in a shell history.
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
  bucket_count          = 25
  keyspace              = 40000

  gcp_project_id = var.gcp_project_id
  gcp_region     = var.gcp_region
  gcp_zones      = var.gcp_zones

  agent_count           = 8
  machine_type          = "n2-standard-8"
  max_workers_per_agent = 4096

  r2_access_key_id     = var.r2_access_key_id
  r2_secret_access_key = var.r2_secret_access_key

  labels = {
    env = "standard"
  }
}
