variable "project_id" {
  description = "GCP project that hosts the load generators."
  type        = string
}

variable "region" {
  description = <<-EOT
    GCP region for the load generators. Must be geographically matched to the
    R2 location hint, otherwise the measurement is dominated by WAN latency
    instead of R2 behaviour (us-west2 pairs with R2 "wnam").
  EOT
  type        = string
}

variable "zones" {
  description = <<-EOT
    Zones the managed instance group spreads across. Spreading limits the blast
    radius of a single-zone capacity shortfall; it does not meaningfully change
    the measurement, since all zones in a region share the same egress path.
  EOT
  type        = list(string)
}

variable "name_prefix" {
  description = "Prefix for every GCP resource this module creates. Derive from deployment_id to keep concurrent stacks apart."
  type        = string
}

variable "agent_count" {
  description = <<-EOT
    Number of load-generator VMs. Each VM is capped by GCP at 1.8 Mpps / 30 Gbps
    of internet ingress regardless of size, so scaling out beats scaling up once
    a single VM saturates.
  EOT
  type        = number
}

variable "machine_type" {
  description = "Machine type per load generator."
  type        = string
  default     = "n2-standard-8"
}

variable "agent_binary_path" {
  description = <<-EOT
    Path to a linux/amd64 build of cmd/agent. Produce it with `make build-agent`
    before running apply. Shipping a prebuilt binary keeps boot deterministic:
    the alternative, building on each VM, adds a toolchain download to the
    critical path and can leave the fleet running mismatched code.
  EOT
  type        = string
}

variable "control_plane_url" {
  description = "Base URL of the Worker control plane, e.g. https://r2bench-x.acme.workers.dev."
  type        = string
}

variable "agent_token" {
  description = "Shared token the agents present to the control plane."
  type        = string
  sensitive   = true
}

variable "r2_access_key_id" {
  description = <<-EOT
    R2 S3 access key id, delivered to the VMs through instance metadata.

    Secret Manager would be the better home for this, but it needs
    roles/secretmanager.admin which is not granted to the SE groups on the
    target project. Metadata is what the available permissions allow.

    Consequences to accept, or design around by scoping the R2 token to the
    benchmark buckets only:
      - readable by anyone with compute.instances.get on the project
      - written to Terraform state, which has no remote backend here
      - written to /etc/r2agent/agent.env on each VM (mode 0600)
  EOT
  type        = string
  sensitive   = true
}

variable "r2_secret_access_key" {
  description = "R2 S3 secret access key. Same exposure caveats as r2_access_key_id."
  type        = string
  sensitive   = true
}

variable "r2_endpoint" {
  description = "Account-scoped R2 S3 endpoint."
  type        = string
}

variable "bucket_prefix" {
  description = "Benchmark bucket name prefix. Must match the r2 module."
  type        = string
}

variable "bucket_count" {
  description = "Number of benchmark buckets. Must match the r2 module."
  type        = number
}

variable "keyspace" {
  description = <<-EOT
    Objects per bucket that the agent selects from. Large enough that a run does
    not repeatedly hit the same keys, which would measure caching rather than
    steady-state reads.
  EOT
  type        = number
  default     = 40000
}

variable "workers_per_agent" {
  description = "Default in-flight request count per agent. The control plane overrides this per job."
  type        = number
  default     = 512
}

variable "poll_interval_seconds" {
  description = "How often an idle agent asks the control plane for work."
  type        = number
  default     = 5
}

variable "metrics_interval_seconds" {
  description = "How often a running agent pushes an interval report. Must stay well under the control plane's 90s staleness threshold."
  type        = number
  default     = 10

  validation {
    condition     = var.metrics_interval_seconds >= 1 && var.metrics_interval_seconds <= 30
    error_message = "metrics_interval_seconds must be between 1 and 30 to stay under the 90s staleness threshold."
  }
}

variable "boot_image" {
  description = "Boot image. Must carry the GVNIC guest OS feature for the gVNIC driver to attach."
  type        = string
  default     = "projects/debian-cloud/global/images/family/debian-12"
}

variable "ssh_source_ranges" {
  description = <<-EOT
    CIDRs allowed to reach port 22. Defaults to Google's IAP TCP forwarding
    range only, so the VMs are not exposed to the public internet even though
    they carry external IPs for R2 egress.
  EOT
  type        = list(string)
  default     = ["35.235.240.0/20"]
}

variable "labels" {
  description = "Labels applied to every resource, for cost attribution."
  type        = map(string)
  default     = {}
}
