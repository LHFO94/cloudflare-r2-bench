output "dashboard_url" {
  description = "Open this to drive the benchmark. Run `terraform output -raw dashboard_url` to reveal it."
  value       = module.control_plane.dashboard_url
  sensitive   = true
}

output "control_plane_url" {
  description = "Base URL of the control plane."
  value       = module.control_plane.worker_url
}

output "agent_count" {
  description = "Use this as the `agents` field when starting a job."
  value       = module.loadgen.agent_count
}

output "bucket_names" {
  value = module.r2.bucket_names
}

output "seed_env" {
  description = <<-EOT
    Export these, add R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, then run
    `go run ./cmd/seeder`. The seeder reads the same R2_* variables as the
    agent, so there is no way for the two to disagree on bucket names or key
    layout.

    Safe to re-run: the seeder writes a sentinel object per bucket and skips any
    bucket already carrying the expected keyspace, because every PUT is a
    billable Class A operation.
  EOT
  value = join("\n", [
    "export R2_ENDPOINT='${module.r2.s3_endpoint}'",
    "export R2_BUCKET_PREFIX='${module.r2.bucket_prefix}'",
    "export R2_BUCKET_COUNT=${module.r2.bucket_count}",
    "export R2_KEYSPACE=${var.keyspace}",
  ])
}

output "ssh_command" {
  value = module.loadgen.ssh_command
}

output "logs_command" {
  value = module.loadgen.logs_command
}

output "d1_query_command" {
  description = "Pull raw per-agent samples out of D1 after a run."
  value       = "npx wrangler d1 execute DB --remote --config wrangler.generated.jsonc --command 'SELECT * FROM JOB_SPAWN_METRICS ORDER BY CREATED_AT DESC LIMIT 50'"
}
