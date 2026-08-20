output "dashboard_url" {
  description = "Operator UI, with the admin token embedded. Reveal with `terraform output -raw dashboard_url`."
  value       = module.stack.dashboard_url
  sensitive   = true
}

output "control_plane_url" {
  value = module.stack.control_plane_url
}

output "agent_count" {
  value = module.stack.agent_count
}

output "seed_env" {
  description = "Environment for `go run ./cmd/seeder`. Add R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY yourself."
  value       = module.stack.seed_env
}

output "ssh_command" {
  value = module.stack.ssh_command
}

output "logs_command" {
  value = module.stack.logs_command
}
