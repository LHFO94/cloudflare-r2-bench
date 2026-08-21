/**
 * Secrets are not represented in wrangler.jsonc, so `wrangler types` cannot
 * discover them. Declaration merging with the generated global `Env`
 * interface adds them without being clobbered on the next `wrangler types`.
 */
interface Env {
	/** Shared token presented by load-generator VMs on /api/agent/* and /api/internal/*. */
	AGENT_TOKEN: string;
	/** Operator token for /api/v1/* and /start. Unset disables the check (local dev only). */
	ADMIN_TOKEN: string;
	/**
	 * Number of load generators Terraform provisioned, as a string because
	 * Worker vars are strings. Advisory only: the control plane still allocates
	 * slots to whichever agents actually poll, so a stale value cannot break a
	 * run, it just makes the UI's suggestion wrong.
	 */
	DEPLOYMENT_AGENTS?: string;
	/**
	 * The agents' MAX_WORKERS, as a string. Jobs requesting more are rejected,
	 * so an operator's chosen worker count is the one that actually runs.
	 */
	MAX_WORKERS_PER_AGENT?: string;
}
