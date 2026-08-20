output "bucket_names" {
  description = "Every provisioned bucket name, in index order."
  value       = cloudflare_r2_bucket.bench[*].name
}

output "bucket_prefix" {
  description = "Prefix the agent and seeder use to derive bucket names."
  value       = var.bucket_prefix
}

output "bucket_count" {
  description = "Number of buckets the agent and seeder should address."
  value       = var.bucket_count
}

output "s3_endpoint" {
  description = <<-EOT
    Account-scoped S3 endpoint. This is the authenticated API surface, not the
    public r2.dev CDN, so responses are not edge-cached and every GET reaches
    R2 itself.
  EOT
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}
