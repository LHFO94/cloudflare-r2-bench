output "worker_url" {
  description = "Base URL of the control plane. Agents post here; operators open it in a browser."
  value       = local.worker_url
}

output "dashboard_url" {
  description = "Ready-to-open operator URL. The token is captured into sessionStorage and stripped from the address bar on load."
  value       = "${local.worker_url}/?token=${random_password.admin_token.result}"
  sensitive   = true
}

output "agent_token" {
  description = "Shared token the load-generator VMs present to the control plane."
  value       = random_password.agent_token.result
  sensitive   = true
}

output "admin_token" {
  description = "Operator token for /api/v1/* and /start."
  value       = random_password.admin_token.result
  sensitive   = true
}

output "d1_database_id" {
  description = "UUID of the metrics database, for ad-hoc `wrangler d1 execute` queries."
  value       = cloudflare_d1_database.metrics.uuid
}

output "deployment_id" {
  description = "Id of the deploy step, so downstream resources can depend on the Worker being live."
  value       = terraform_data.secrets.id
}

output "access_client_id" {
  description = "Cloudflare Access service token client id, empty when no token was created."
  value       = try(cloudflare_zero_trust_access_service_token.agents[0].client_id, "")
}

output "access_client_secret" {
  description = "Cloudflare Access service token client secret, empty when no token was created."
  value       = try(cloudflare_zero_trust_access_service_token.agents[0].client_secret, "")
  sensitive   = true
}

output "access_service_token_name" {
  description = "Name of the service token, to find it when attaching a Service Auth policy."
  value       = try(cloudflare_zero_trust_access_service_token.agents[0].name, "")
}
