terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

locals {
  labels = merge({ component = "r2-loadgen" }, var.labels)
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
# A dedicated VPC rather than the default network: the default network's
# permissive firewall rules would put ports 22, 3389 and all internal traffic on
# the public internet for VMs that carry external IPs.
resource "google_compute_network" "bench" {
  project                 = var.project_id
  name                    = "${var.name_prefix}-net"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "bench" {
  project       = var.project_id
  name          = "${var.name_prefix}-subnet"
  region        = var.region
  network       = google_compute_network.bench.id
  ip_cidr_range = "10.128.0.0/20"
}

# SSH via IAP only. The VMs need external IPs so that R2 traffic leaves
# directly rather than through Cloud NAT, which would funnel the entire fleet
# through a shared, port-limited gateway and become the bottleneck.
resource "google_compute_firewall" "ssh" {
  project       = var.project_id
  name          = "${var.name_prefix}-allow-ssh"
  network       = google_compute_network.bench.name
  source_ranges = var.ssh_source_ranges
  target_tags   = [var.name_prefix]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Deny-by-default inbound: GCP already blocks unsolicited ingress, but an
# explicit low-priority deny makes that intent auditable and survives someone
# adding a broad allow rule later.
resource "google_compute_firewall" "deny_ingress" {
  project     = var.project_id
  name        = "${var.name_prefix}-deny-ingress"
  network     = google_compute_network.bench.name
  direction   = "INGRESS"
  priority    = 65534
  target_tags = [var.name_prefix]

  source_ranges = ["0.0.0.0/0"]

  deny {
    protocol = "all"
  }
}

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------
resource "google_service_account" "agent" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-agent"
  display_name = "R2 benchmark load generator"
}

# The agents are intentionally granted nothing at project level.
#
# roles/logging.logWriter and roles/monitoring.metricWriter would let them ship
# to Cloud Logging, but granting either needs resourcemanager.projectIamAdmin,
# which the SE groups do not hold on the target project. Agent output therefore
# stays on the VM: journald, plus the serial console, both reachable with the
# compute permissions we do have. See the logs_command output.
#
# Bucket-level access to the artifact bucket is granted separately below;
# storage.admin covers that, so it needs no project-level role.

# ---------------------------------------------------------------------------
# Agent artifact
# ---------------------------------------------------------------------------
resource "google_storage_bucket" "artifacts" {
  project                     = var.project_id
  name                        = "${var.name_prefix}-artifacts"
  location                    = var.region
  force_destroy               = true
  uniform_bucket_level_access = true
  labels                      = local.labels
}

resource "google_storage_bucket_object" "agent" {
  bucket = google_storage_bucket.artifacts.name
  # Content-addressed: a rebuilt agent produces a new object name, which changes
  # the startup script, which rolls the instance template. Without this the MIG
  # would keep booting the old binary from an unchanged object name.
  #
  # The fileexists guard is not redundant with the precondition below: Terraform
  # does not guarantee the precondition is evaluated before the attribute
  # expressions, and a bare filesha256 on a missing file aborts the plan with an
  # opaque error instead of the actionable one.
  name   = "agent-${fileexists(var.agent_binary_path) ? filesha256(var.agent_binary_path) : "missing"}"
  source = var.agent_binary_path

  lifecycle {
    precondition {
      condition     = fileexists(var.agent_binary_path)
      error_message = "Agent binary not found at ${var.agent_binary_path}. Run `make build-agent` from the repository root first."
    }
  }
}

resource "google_storage_bucket_iam_member" "agent_reads_artifacts" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.agent.email}"
}

# ---------------------------------------------------------------------------
# Instance template
# ---------------------------------------------------------------------------
locals {
  startup_script = templatefile("${path.module}/startup.sh.tftpl", {
    artifact_bucket      = google_storage_bucket.artifacts.name
    artifact_object      = google_storage_bucket_object.agent.name
    r2_access_key_id     = var.r2_access_key_id
    r2_secret_access_key = var.r2_secret_access_key
    r2_endpoint          = var.r2_endpoint
    bucket_prefix        = var.bucket_prefix
    bucket_count         = var.bucket_count
    keyspace             = var.keyspace
    control_plane_url    = var.control_plane_url
    agent_token          = var.agent_token
    access_client_id     = var.access_client_id
    access_client_secret = var.access_client_secret
    region               = var.region
    # Ceiling on goroutines the agent will spin up, independent of what a job
    # asks for. Four times the configured default leaves room to push a single
    # agent harder without rebuilding the fleet, while still bounding memory.
    max_workers              = var.workers_per_agent * 4
    poll_interval_seconds    = var.poll_interval_seconds
    metrics_interval_seconds = var.metrics_interval_seconds
  })
}

resource "google_compute_instance_template" "agent" {
  project     = var.project_id
  name_prefix = "${var.name_prefix}-"
  region      = var.region

  machine_type = var.machine_type
  tags         = [var.name_prefix]
  labels       = local.labels

  disk {
    source_image = var.boot_image
    boot         = true
    auto_delete  = true
    disk_type    = "pd-balanced"
    disk_size_gb = 20
    # Required for the gVNIC driver to attach; without it nic_type = "GVNIC"
    # silently falls back to virtio.
    guest_os_features = ["GVNIC"]
  }

  network_interface {
    subnetwork = google_compute_subnetwork.bench.id
    # gVNIC raises the packet-per-second ceiling over virtio, which matters
    # because this workload is small-object and therefore packet-bound rather
    # than bandwidth-bound.
    nic_type = "GVNIC"

    # Ephemeral external IP. Deliberately not Cloud NAT: a shared NAT gateway
    # would cap the fleet on port allocation long before R2 became the limit.
    access_config {
      network_tier = "PREMIUM"
    }
  }

  # network_performance_config / TIER_1 is intentionally omitted. Tier_1 raises
  # *egress* only, and this workload's egress is a trickle of GET headers; the
  # binding constraint is the flat per-VM internet ingress cap, which Tier_1
  # does not change. It also requires larger machine types than are needed here.

  service_account {
    email  = google_service_account.agent.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin = "TRUE"
    # With no Cloud Logging grant, the serial console is the only way to see a
    # boot failure that happens before SSH is usable.
    serial-port-logging-enable = "TRUE"
  }

  metadata_startup_script = local.startup_script

  scheduling {
    # On-demand, not Spot. PREEMPTIBLE_CPUS quota is zero in the target project,
    # and a preemption mid-run would invalidate the measurement anyway.
    preemptible       = false
    automatic_restart = true
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [google_storage_bucket_iam_member.agent_reads_artifacts]
}

# ---------------------------------------------------------------------------
# Managed instance group
# ---------------------------------------------------------------------------
resource "google_compute_region_instance_group_manager" "agents" {
  project            = var.project_id
  name               = "${var.name_prefix}-mig"
  region             = var.region
  base_instance_name = "${var.name_prefix}-agent"
  target_size        = var.agent_count

  distribution_policy_zones = var.zones

  version {
    name              = "primary"
    instance_template = google_compute_instance_template.agent.self_link_unique
  }

  update_policy {
    type                         = "PROACTIVE"
    minimal_action               = "REPLACE"
    instance_redistribution_type = "PROACTIVE"
    # Replace the whole fleet at once. There is no availability requirement
    # here, and a rolling update would leave a job running against a mix of
    # agent versions.
    max_surge_fixed       = 0
    max_unavailable_fixed = var.agent_count
  }

  # Block apply until every VM exists, so the operator does not start a job
  # against a half-provisioned fleet and get a misleading result. Note this
  # waits for RUNNING, not for the startup script to finish; confirm the agent
  # count on the watch page before trusting a run.
  wait_for_instances        = true
  wait_for_instances_status = "STABLE"

  depends_on = [google_storage_bucket_iam_member.agent_reads_artifacts]
}
