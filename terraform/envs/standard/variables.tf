variable "deployment_id" {
  description = "Short unique name for this deployment; every resource is named from it."
  type        = string
}

variable "cloudflare_account_id" {
  type = string
}

variable "workers_dev_subdomain" {
  description = "The account's workers.dev subdomain, without \".workers.dev\"."
  type        = string
}

variable "gcp_project_id" {
  type = string
}

variable "gcp_region" {
  description = "Must be colocated with R2 \"wnam\"; us-west2 has the verified vCPU and IP quota."
  type        = string
  default     = "us-west2"
}

variable "gcp_zones" {
  type    = list(string)
  default = ["us-west2-a", "us-west2-b", "us-west2-c"]
}

variable "r2_access_key_id" {
  description = "R2 S3 access key id. Set via TF_VAR_r2_access_key_id; do not put it in tfvars."
  type        = string
  sensitive   = true
}

variable "r2_secret_access_key" {
  description = "R2 S3 secret access key. Set via TF_VAR_r2_secret_access_key; do not put it in tfvars."
  type        = string
  sensitive   = true
}
