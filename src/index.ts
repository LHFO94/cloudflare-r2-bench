import { orchestrator_route } from "./orchestrator";
import { process_benchmark_spawn_iteration } from "./spawn";
import { JobSpawnRequest } from "./types";
export { BenchmarkContainer } from "./container";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await orchestrator_route(request, env, ctx);
		} catch(err) {
			console.error(`Unexpected error while processing request, ${err}`)
			return Response.json({"status": "error"}, {status: 503})
		}
	},
	async queue(batch: MessageBatch<JobSpawnRequest>, env: Env): Promise<void> {
		for (const message of batch.messages) {
			try {
				const result = await process_benchmark_spawn_iteration(env, message.body);
				if (result.continue) {
					await env.r2bench_spawns.send(message.body, { delaySeconds: result.delaySeconds });
				}
				message.ack();
			} catch (error) {
				console.error(`Failed to process queue message ${message.id}, ${error instanceof Error ? error.message : String(error)}`);
				message.retry({ delaySeconds: Math.min(message.attempts * 5, 60) });
			}
		}
	},
} satisfies ExportedHandler<Env, JobSpawnRequest>;
