import { orchestrator_route } from "./orchestrator";
import { continue_bench, spawn_job } from "./spawn";
import { MessageQueueType } from "./types";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await orchestrator_route(request, env, ctx);
		} catch(err) {
			console.error(`Unexpected error while processing request, ${err}`)
			return Response.json({"status": "error"}, {status: 503})
		}
	},

	async queue(batch, env, ctx): Promise<void> {
		for (const message of batch.messages) {
			console.info("consumed from our queue:", JSON.stringify(message.body));
			try {
				ctx.waitUntil(processMessage(message, env, ctx));
				message.ack();
			} catch (err) {
				console.error(err)
			}
		}
	},
} satisfies ExportedHandler<Env>;


async function processMessage(message: Message<unknown>, env: Env, ctx: ExecutionContext<unknown>) {
	try {
		const mqt = message.body as MessageQueueType;
		if (mqt.type == "spawn") {
			await spawn_job(mqt, env, ctx);
		} else if (mqt.type == "spawn_continue") {
			await continue_bench(mqt.status.spawnId, mqt.request, env, mqt.status);
		}
	} catch(err) {
		console.error(`Error while processing messages ${err}`, err)
	}
}

