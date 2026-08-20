import { orchestrator_route } from "./orchestrator";
import { reap_jobs } from "./spawn";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await orchestrator_route(request, env, ctx);
		} catch (err) {
			console.error(`Unexpected error while processing request, ${err}`);
			return Response.json({ status: "error" }, { status: 503 });
		}
	},

	/**
	 * Reconciliation sweep.
	 *
	 * Errors are logged rather than thrown: a failing cron invocation is not
	 * retried, and the next minute's tick performs the same idempotent work.
	 */
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		try {
			const result = await reap_jobs(env);
			if (result.finalised || result.staleSpawns || result.abandoned) {
				console.log(`Reaper: finalised=${result.finalised} staleSpawns=${result.staleSpawns} abandoned=${result.abandoned}`);
			}
		} catch (err) {
			console.error(`Reaper failed, ${err}`);
		}
	},
} satisfies ExportedHandler<Env>;
