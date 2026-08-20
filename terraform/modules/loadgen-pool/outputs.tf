output "instance_group" {
  description = "Self link of the managed instance group holding the load generators."
  value       = google_compute_region_instance_group_manager.agents.instance_group
}

output "service_account_email" {
  description = "Service account the agents run as."
  value       = google_service_account.agent.email
}

output "artifact_bucket" {
  description = "GCS bucket holding the agent binary."
  value       = google_storage_bucket.artifacts.name
}

output "agent_count" {
  description = "Number of load generators provisioned. Use this as the `agents` value when starting a job."
  value       = var.agent_count
}

output "ssh_command" {
  description = "Reach a single agent for debugging. IAP tunnelling, since port 22 is not open to the internet."
  value       = "gcloud compute ssh ${google_compute_region_instance_group_manager.agents.base_instance_name}-<suffix> --project=${var.project_id} --zone=${var.zones[0]} --tunnel-through-iap"
}

output "logs_command" {
  description = "Tail agent logs across the fleet without SSHing into saturated VMs."
  value       = "gcloud logging read 'resource.type=gce_instance AND logName:syslog AND textPayload:r2agent' --project=${var.project_id} --limit=100 --freshness=10m"
}
