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
  description = <<-EOT
    Read agent output from the serial console. Cloud Logging is not available:
    shipping there needs roles/logging.logWriter on the agent service account,
    and granting it needs project IAM admin, which we do not have. The serial
    console needs only compute permissions and survives a saturated VM better
    than an SSH session does.
  EOT
  value       = "gcloud compute instances get-serial-port-output ${google_compute_region_instance_group_manager.agents.base_instance_name}-<suffix> --project=${var.project_id} --zone=${var.zones[0]} | grep r2agent"
}

output "list_instances_command" {
  description = "Names of the running load generators, to fill in <suffix> above."
  value       = "gcloud compute instance-groups list-instances ${google_compute_region_instance_group_manager.agents.name} --region=${var.region} --project=${var.project_id}"
}
