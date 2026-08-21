variable "deployment_id" {
  description = <<-EOT
    Short, unique name for this deployment. Every Cloudflare and GCP resource is
    named from it, so two people can stand up the harness in the same accounts
    without colliding.

    Changing it after a run is the supported way to move to a different R2
    location: R2 remembers a bucket name's location forever, so reusing an id
    would silently keep the old region.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,20}$", var.deployment_id))
    error_message = "deployment_id must be 2-21 lowercase alphanumeric characters or hyphens."
  }
}

# ---------------------------------------------------------------------------
# Cloudflare
# ---------------------------------------------------------------------------
variable "cloudflare_account_id" {
  type = string
}

variable "workers_dev_subdomain" {
  description = "The account's workers.dev subdomain, without \".workers.dev\"."
  type        = string
}

variable "r2_location" {
  description = "R2 location hint. Must be geographically matched to gcp_region."
  type        = string
  default     = "wnam"
}

variable "bucket_count" {
  type    = number
  default = 25
}

variable "keyspace" {
  type    = number
  default = 40000
}

# ---------------------------------------------------------------------------
# GCP
# ---------------------------------------------------------------------------
variable "gcp_project_id" {
  type = string
}

variable "gcp_region" {
  type = string
}

variable "gcp_zones" {
  type = list(string)
}

variable "agent_count" {
  type = number
}

variable "machine_type" {
  type    = string
  default = "n2-standard-8"
}

variable "max_workers_per_agent" {
  description = "Hard ceiling on in-flight requests per agent. See the loadgen-pool variable of the same name."
  type        = number
  default     = 4096
}

variable "r2_access_key_id" {
  description = <<-EOT
    R2 S3 access key id. Reaches the VMs through instance metadata, because
    Secret Manager needs roles/secretmanager.admin which the SE groups do not
    hold on the target project.

    Supply it via TF_VAR_r2_access_key_id rather than a tfvars file, and scope
    the R2 token to the benchmark buckets so that metadata exposure is bounded.
  EOT
  type        = string
  sensitive   = true
}

variable "r2_secret_access_key" {
  description = "R2 S3 secret access key. Supply via TF_VAR_r2_secret_access_key."
  type        = string
  sensitive   = true
}

variable "labels" {
  type    = map(string)
  default = {}
}

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
variable "repo_root" {
  description = "Absolute path to the repository root."
  type        = string
}
