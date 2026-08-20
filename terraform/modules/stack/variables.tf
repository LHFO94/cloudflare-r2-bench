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

variable "workers_per_agent" {
  type    = number
  default = 512
}

variable "r2_credentials_secret_id" {
  description = "Secret Manager secret holding the R2 S3 credentials. Created out of band; see the README."
  type        = string
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
