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
}
