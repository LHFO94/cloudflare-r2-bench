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
  name = "r2bench-${var.deployment_id}"

  # R2 and GCP have no shared notion of geography, so the pairing is asserted
  # here rather than left to whoever fills in the tfvars. A mismatched pair
  # measures the transit between two continents, not R2.
  region_pairs = {
    wnam = ["us-west1", "us-west2", "us-west3", "us-west4", "us-central1"]
    enam = ["us-east1", "us-east4", "us-east5", "northamerica-northeast1", "northamerica-northeast2"]
    weur = ["europe-west1", "europe-west2", "europe-west3", "europe-west4", "europe-west9", "europe-southwest1"]
    eeur = ["europe-central2", "europe-north1", "europe-west8"]
    apac = ["asia-east1", "asia-east2", "asia-northeast1", "asia-northeast2", "asia-northeast3", "asia-south1", "asia-southeast1"]
    oc   = ["australia-southeast1", "australia-southeast2"]
  }
}

# ---------------------------------------------------------------------------
# Guardrails
# ---------------------------------------------------------------------------
resource "terraform_data" "region_pairing_check" {
  lifecycle {
    precondition {
      condition     = contains(local.region_pairs[var.r2_location], var.gcp_region)
      error_message = "gcp_region ${var.gcp_region} is not colocated with R2 location ${var.r2_location}. Expected one of: ${join(", ", local.region_pairs[var.r2_location])}."
    }

    precondition {
      condition     = alltrue([for z in var.gcp_zones : startswith(z, "${var.gcp_region}-")])
      error_message = "Every entry in gcp_zones must be a zone within gcp_region (${var.gcp_region})."
    }
  }
}

# ---------------------------------------------------------------------------
# Storage under test
# ---------------------------------------------------------------------------
module "r2" {
  source = "../r2"

  cloudflare_account_id = var.cloudflare_account_id
  bucket_prefix         = "${local.name}-"
  bucket_count          = var.bucket_count
  location              = var.r2_location
}

# ---------------------------------------------------------------------------
# Control plane
# ---------------------------------------------------------------------------
module "control_plane" {
  source = "../control-plane"

  cloudflare_account_id = var.cloudflare_account_id
  worker_name           = local.name
  workers_dev_subdomain = var.workers_dev_subdomain
  d1_location_hint      = var.r2_location
  agent_count           = var.agent_count
  r2_account_id         = var.cloudflare_account_id
  repo_root             = var.repo_root
}

# ---------------------------------------------------------------------------
# Load generators
# ---------------------------------------------------------------------------
# Created last: an agent that boots before the Worker exists would spend its
# first minutes logging poll failures, and the MIG waits for STABLE, which would
# make that the operator's problem.
module "loadgen" {
  source = "../loadgen-pool"

  project_id  = var.gcp_project_id
  region      = var.gcp_region
  zones       = var.gcp_zones
  name_prefix = local.name
  labels      = merge({ deployment = var.deployment_id }, var.labels)

  agent_count       = var.agent_count
  machine_type      = var.machine_type
  workers_per_agent = var.workers_per_agent
  agent_binary_path = "${var.repo_root}/dist/agent-linux-amd64"

  control_plane_url = module.control_plane.worker_url
  agent_token       = module.control_plane.agent_token

  access_client_id     = module.control_plane.access_client_id
  access_client_secret = module.control_plane.access_client_secret

  r2_access_key_id     = var.r2_access_key_id
  r2_secret_access_key = var.r2_secret_access_key
  r2_endpoint          = module.r2.s3_endpoint
  bucket_prefix        = module.r2.bucket_prefix
  bucket_count         = module.r2.bucket_count
  keyspace             = var.keyspace

  depends_on = [
    terraform_data.region_pairing_check,
    module.control_plane,
    module.r2,
  ]
}
