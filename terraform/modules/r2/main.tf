terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.23"
    }
  }
}

/**
 * Benchmark buckets.
 *
 * Standard storage class: the workload is a read flood, and InfrequentAccess
 * would bill Class B operations at a higher rate for no benefit.
 *
 * Buckets are deliberately not managed with prevent_destroy. They hold nothing
 * but synthetic fixtures and the whole point of the stack is that it can be
 * torn down after a run.
 */
resource "cloudflare_r2_bucket" "bench" {
  count = var.bucket_count

  account_id    = var.cloudflare_account_id
  name          = format("%s%02d", var.bucket_prefix, count.index)
  location      = var.location
  storage_class = "Standard"
}
