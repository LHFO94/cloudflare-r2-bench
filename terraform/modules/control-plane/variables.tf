variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the Worker and the D1 database."
  type        = string
}

variable "worker_name" {
  description = <<-EOT
    Worker script name. Also determines the workers.dev hostname, so it must be
    unique within the account. Derive it from deployment_id so that two
    concurrent deployments cannot overwrite each other's Worker.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,62}$", var.worker_name))
    error_message = "worker_name must be lowercase alphanumeric with hyphens."
  }
}

variable "workers_dev_subdomain" {
  description = <<-EOT
    The account's workers.dev subdomain, without ".workers.dev". Find it under
    Workers & Pages > Overview in the dashboard, or in the URL of any deployed
    Worker. Needed up front because the load-generator VMs are given the
    control-plane URL in their instance metadata at creation time.
  EOT
  type        = string
}

variable "d1_location_hint" {
  description = <<-EOT
    Primary location for the D1 database. Put it near the load generators: the
    agents write metrics to it every 10 seconds, and a transatlantic round trip
    per report wastes agent CPU that should be driving load.
  EOT
  type        = string
  default     = "wnam"

  validation {
    condition     = contains(["wnam", "enam", "weur", "eeur", "apac", "oc"], var.d1_location_hint)
    error_message = "d1_location_hint must be one of wnam, enam, weur, eeur, apac, oc."
  }
}

variable "r2_account_id" {
  description = "Account id baked into the Worker as R2_ACCOUNT_ID. Normally the same as cloudflare_account_id."
  type        = string
}

variable "repo_root" {
  description = "Absolute path to the repository root, where wrangler and the migrations live."
  type        = string
}

variable "wrangler_command" {
  description = "How to invoke wrangler. Overridable for pinned or containerised installs."
  type        = string
  default     = "npx --yes wrangler@4"
}
