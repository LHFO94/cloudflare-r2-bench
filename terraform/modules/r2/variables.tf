variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the buckets and the control plane."
  type        = string
}

variable "bucket_prefix" {
  description = <<-EOT
    Prefix for every benchmark bucket. Bucket names are "<prefix><NN>" with NN
    zero-padded to two digits, which must match Naming.BucketName in
    internal/r2/naming.go.

    R2 pins a bucket's location the first time a name is used and remembers it
    for that name forever, even after the bucket is deleted. Recreating this
    stack with the same prefix in a different location silently reuses the old
    location, so change the prefix (via deployment_id) rather than reusing one.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,50}-$", var.bucket_prefix))
    error_message = "bucket_prefix must be lowercase alphanumeric with hyphens and end in a hyphen."
  }
}

variable "bucket_count" {
  description = <<-EOT
    Number of buckets to spread load across. Multiple buckets exist to avoid
    concentrating the whole run on a single bucket's shard of R2's metadata
    layer; the object keyspace within each bucket does the rest.
  EOT
  type        = number
  default     = 25

  validation {
    condition     = var.bucket_count >= 1 && var.bucket_count <= 99
    error_message = "bucket_count must be between 1 and 99 (bucket names use a two-digit suffix)."
  }
}

variable "location" {
  description = <<-EOT
    R2 location hint. Must be the region closest to the load generators, or the
    measurement is dominated by WAN latency rather than R2 itself.
    One of: wnam, enam, weur, eeur, apac, oc.
  EOT
  type        = string
  default     = "wnam"

  validation {
    condition     = contains(["wnam", "enam", "weur", "eeur", "apac", "oc"], var.location)
    error_message = "location must be one of wnam, enam, weur, eeur, apac, oc."
  }
}
