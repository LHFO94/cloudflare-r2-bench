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
  description = "Single zone is fine for a smoke run; there is nothing to spread."
  type        = list(string)
  default     = ["us-west2-a"]
}

variable "r2_credentials_secret_id" {
  description = "Secret Manager secret holding the R2 S3 credentials. Created out of band; see the README."
  type        = string
}
