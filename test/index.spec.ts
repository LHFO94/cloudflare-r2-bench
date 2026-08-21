import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { rps_for_slot } from "../src/agents";
import worker from "../src/index";
import { reap_jobs } from "../src/spawn";
import type { AgentPollResponse, JobStartResponse, WatchResponse } from "../src/types";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const AGENT_TOKEN = "test-agent-token";

async function post<T>(path: string, body: unknown): Promise<{ status: number, body: T }> {
	const request = new IncomingRequest(`http://example.com${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: await response.json() as T };
}

async function poll(agentId: string): Promise<AgentPollResponse> {
	const { body } = await post<AgentPollResponse>("/api/agent/poll", {
		token: AGENT_TOKEN,
		agentId,
		region: "us-west2",
	});
	return body;
}

/** Start a job and return its id, failing loudly if the control plane rejected it. */
async function startJob(overrides: Record<string, unknown> = {}): Promise<string> {
	const { body } = await post<JobStartResponse>("/api/v1/start", {
		targetRPS: 1000,
		agents: 3,
		workersPerAgent: 128,
		duration: 10,
		startDelaySeconds: 30,
		...overrides,
	});
	expect(body.status, body.message).toBe("success");
	return body.jobId!;
}

beforeEach(async () => {
	// setupFiles builds the schema once per file; each test starts from empty
	// tables so job-uniqueness checks do not leak across cases.
	await env.DB.batch([
		env.DB.prepare("DELETE FROM JOB_SPAWN_METRICS"),
		env.DB.prepare("DELETE FROM JOB_SPAWNS"),
		env.DB.prepare("DELETE FROM JOBS"),
	]);
});

describe("static assets", () => {
	it("serves the landing page", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("R2 benchmark");
	});
});

describe("rps_for_slot", () => {
	it("distributes the remainder so slices sum to the target", () => {
		const agents = 8;
		const target = 80_003;
		const slices = Array.from({ length: agents }, (_, slot) => rps_for_slot(target, agents, slot));

		expect(slices.reduce((a, b) => a + b, 0)).toBe(target);
		// No agent may carry more than one extra request per second.
		expect(Math.max(...slices) - Math.min(...slices)).toBeLessThanOrEqual(1);
	});

	it("returns zero rather than dividing by zero when there are no agents", () => {
		expect(rps_for_slot(100, 0, 0)).toBe(0);
	});
});

describe("job start validation", () => {
	it("rejects a target RPS lower than the agent count", async () => {
		const { body } = await post<JobStartResponse>("/api/v1/start", {
			targetRPS: 4, agents: 8, duration: 5,
		});
		expect(body.status).toBe("error");
		expect(body.jobId).toBeUndefined();
	});

	it("allows targetRPS below the agent count when unthrottled", async () => {
		const { body } = await post<JobStartResponse>("/api/v1/start", {
			targetRPS: 1, agents: 8, duration: 5, unthrottled: true,
		});
		expect(body.status).toBe("success");
	});

	it("refuses a second concurrent job", async () => {
		await startJob();
		const { body } = await post<JobStartResponse>("/api/v1/start", {
			targetRPS: 100, agents: 1, duration: 5,
		});
		expect(body.status).toBe("error");
		expect(body.message).toContain("still active");
	});

	it("derives the run window from the start delay and duration", async () => {
		const before = Date.now();
		const jobId = await startJob({ duration: 15, startDelaySeconds: 30 });
		const job = await env.DB.prepare("SELECT START_AT, STOP_AT FROM JOBS WHERE JOB_ID = ?")
			.bind(jobId).first();

		const startAt = job!["START_AT"] as number;
		const stopAt = job!["STOP_AT"] as number;
		expect(startAt).toBeGreaterThanOrEqual(before + 30_000);
		expect(stopAt - startAt).toBe(15 * 60 * 1000);
	});
});

describe("agent poll", () => {
	it("rejects a bad token with 401", async () => {
		const { status } = await post("/api/agent/poll", { token: "wrong", agentId: "vm-0" });
		expect(status).toBe(401);
	});

	it("is idle when no job is queued", async () => {
		expect((await poll("vm-0")).action).toBe("idle");
	});

	it("hands out disjoint slots and shards the target RPS", async () => {
		const jobId = await startJob({ targetRPS: 1000, agents: 3 });

		const responses = [await poll("vm-0"), await poll("vm-1"), await poll("vm-2")];

		expect(responses.every((r) => r.action === "run")).toBe(true);
		expect(responses.every((r) => r.jobId === jobId)).toBe(true);
		expect(new Set(responses.map((r) => r.spawnId)).size).toBe(3);
		expect(responses.reduce((sum, r) => sum + r.targetRPS!, 0)).toBe(1000);
		expect(responses[0].workers).toBe(128);
	});

	it("moves the job from QUEUED to RUNNING on first check-in", async () => {
		const jobId = await startJob();
		await poll("vm-0");
		const job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		expect(job!["STATUS"]).toBe("RUNNING");
	});

	it("returns the same slot to a reconnecting agent", async () => {
		await startJob({ agents: 3 });
		const first = await poll("vm-1");
		const second = await poll("vm-1");

		expect(second.spawnId).toBe(first.spawnId);
		expect(second.targetRPS).toBe(first.targetRPS);

		const count = await env.DB.prepare("SELECT COUNT(*) AS C FROM JOB_SPAWNS").first();
		expect(count!["C"]).toBe(1);
	});

	it("refuses extra agents once every slot is filled", async () => {
		await startJob({ agents: 2 });
		await poll("vm-0");
		await poll("vm-1");

		const extra = await poll("vm-2");
		expect(extra.action).toBe("idle");
		expect(extra.message).toContain("slots filled");
	});

	it("does not admit agents to a job whose window has closed", async () => {
		const jobId = await startJob();
		await env.DB.prepare("UPDATE JOBS SET STOP_AT = ? WHERE JOB_ID = ?")
			.bind(Date.now() - 1000, jobId).run();

		expect((await poll("vm-0")).action).toBe("idle");
	});

	it("does not admit agents to a stopping job", async () => {
		const jobId = await startJob();
		await post("/api/v1/stop", { jobId });
		expect((await poll("vm-0")).action).toBe("idle");
	});
});

describe("agent callbacks", () => {
	it("rejects metrics carrying a bad token", async () => {
		const jobId = await startJob();
		const { spawnId } = await poll("vm-0");
		const { status } = await post("/api/internal/spawn-metrics", {
			token: "wrong", spawnId, jobId, tickNumber: 0,
			latency: 1, rps: 1, count: 1, avgLatency: 1, actualRPS: 1, totalCount: 1,
		});
		expect(status).toBe(401);
	});

	it("stores percentiles and refreshes the spawn heartbeat", async () => {
		const jobId = await startJob();
		const { spawnId } = await poll("vm-0");

		await env.DB.prepare("UPDATE JOB_SPAWNS SET LAST_SEEN = 0 WHERE SPAWN_ID = ?").bind(spawnId).run();

		const { status } = await post("/api/internal/spawn-metrics", {
			token: AGENT_TOKEN, spawnId, jobId, tickNumber: 1,
			latency: 12.5, rps: 300, count: 3000, errorM1Rate: 0.5,
			avgLatency: 11, actualRPS: 290, totalCount: 5800,
			p50: 9, p95: 40, p99: 90, bytes: 4_500_000, status4xx: 2, status5xx: 1,
		});
		expect(status).toBe(200);

		const metric = await env.DB.prepare("SELECT * FROM JOB_SPAWN_METRICS WHERE SPAWN_ID = ?").bind(spawnId).first();
		expect(metric!["P99"]).toBe(90);
		expect(metric!["BYTES"]).toBe(4_500_000);
		expect(metric!["STATUS_5XX"]).toBe(1);

		const spawn = await env.DB.prepare("SELECT LAST_SEEN, COUNT FROM JOB_SPAWNS WHERE SPAWN_ID = ?").bind(spawnId).first();
		expect(spawn!["COUNT"]).toBe(5800);
		expect(spawn!["LAST_SEEN"] as number).toBeGreaterThan(0);
	});

	it("completes the job only after the last agent reports", async () => {
		const jobId = await startJob({ agents: 2 });
		const a = await poll("vm-0");
		const b = await poll("vm-1");

		await post("/api/internal/spawn-complete", { token: AGENT_TOKEN, spawnId: a.spawnId, jobId });
		let job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		expect(job!["STATUS"]).toBe("RUNNING");

		await post("/api/internal/spawn-complete", { token: AGENT_TOKEN, spawnId: b.spawnId, jobId });
		job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		expect(job!["STATUS"]).toBe("COMPLETED");
	});

	it("fails the whole job when an agent reports an error", async () => {
		const jobId = await startJob({ agents: 2 });
		const a = await poll("vm-0");

		await post("/api/internal/spawn-complete", { token: AGENT_TOKEN, spawnId: a.spawnId, jobId, error: "connection reset" });

		const job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		expect(job!["STATUS"]).toBe("FAILED");
	});
});

describe("watch", () => {
	it("sums RPS across agents and weights latency by request count", async () => {
		const jobId = await startJob({ agents: 2 });
		const a = await poll("vm-0");
		const b = await poll("vm-1");

		// vm-0 is fast and busy, vm-1 is slow and idle. An unweighted mean
		// would report ~55ms; the weighted mean must stay near vm-0's 10ms.
		await env.DB.batch([
			env.DB.prepare(`INSERT INTO JOB_SPAWN_METRICS (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, COUNT, ERROR_M1_RATE, P95, P99, BYTES, CREATED_AT)
				VALUES (?, ?, ?, 0, 10, 900, 9000, 0, 15, 20, 1000, '2026-01-01 00:00:10')`).bind(crypto.randomUUID(), a.spawnId, jobId),
			env.DB.prepare(`INSERT INTO JOB_SPAWN_METRICS (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, COUNT, ERROR_M1_RATE, P95, P99, BYTES, CREATED_AT)
				VALUES (?, ?, ?, 0, 100, 10, 100, 0, 150, 400, 2000, '2026-01-01 00:00:20')`).bind(crypto.randomUUID(), b.spawnId, jobId),
		]);

		const { body } = await post<WatchResponse>("/api/v1/watch", { jobId });

		expect(body.runningContainers).toBe(2);
		expect(body.metrics).toHaveLength(1);
		const m = body.metrics[0];
		expect(m.rps).toBe(910);
		expect(m.workerCount).toBe(2);
		expect(m.bytes).toBe(3000);
		expect(m.p99).toBe(400);
		// (10*9000 + 100*100) / 9100
		expect(m.latency).toBeCloseTo(10.989, 2);
	});

	it("reports unknown for a job that does not exist", async () => {
		const { body } = await post<WatchResponse>("/api/v1/watch", { jobId: "nope" });
		expect(body.status).toBe("unknown");
	});
});

describe("reaper", () => {
	it("finalises a job whose window closed and completes its spawns", async () => {
		const jobId = await startJob();
		const { spawnId } = await poll("vm-0");
		await env.DB.prepare("UPDATE JOBS SET STOP_AT = ? WHERE JOB_ID = ?")
			.bind(Date.now() - 60_000, jobId).run();

		const result = await reap_jobs(env);
		expect(result.finalised).toBe(1);

		const job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		const spawn = await env.DB.prepare("SELECT STATUS FROM JOB_SPAWNS WHERE SPAWN_ID = ?").bind(spawnId).first();
		expect(job!["STATUS"]).toBe("COMPLETED");
		expect(spawn!["STATUS"]).toBe("COMPLETED");
	});

	it("fails a short job whose window closed without any agent joining", async () => {
		// The abandoned-job sweep only fires after five minutes, so a job
		// shorter than that reaches the expired-window branch first. It must
		// not be recorded as COMPLETED just because it was brief: there are no
		// spawns and no metrics, which is a failed run, not a successful one.
		const jobId = await startJob();
		await env.DB.prepare("UPDATE JOBS SET STOP_AT = ? WHERE JOB_ID = ?")
			.bind(Date.now() - 60_000, jobId).run();

		const result = await reap_jobs(env);
		expect(result.finalised).toBe(1);

		const job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		expect(job!["STATUS"]).toBe("FAILED");
	});

	it("fails a spawn that stopped reporting", async () => {
		await startJob();
		const { spawnId } = await poll("vm-0");
		await env.DB.prepare("UPDATE JOB_SPAWNS SET LAST_SEEN = ? WHERE SPAWN_ID = ?")
			.bind(Date.now() - 300_000, spawnId).run();

		const result = await reap_jobs(env);
		expect(result.staleSpawns).toBe(1);

		const spawn = await env.DB.prepare("SELECT STATUS FROM JOB_SPAWNS WHERE SPAWN_ID = ?").bind(spawnId).first();
		expect(spawn!["STATUS"]).toBe("FAILED");
	});

	it("fails a queued job that no agent ever joined", async () => {
		const jobId = await startJob();
		await env.DB.prepare("UPDATE JOBS SET START_AT = ? WHERE JOB_ID = ?")
			.bind(Date.now() - 600_000, jobId).run();

		const result = await reap_jobs(env);
		expect(result.abandoned).toBe(1);

		const job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		expect(job!["STATUS"]).toBe("FAILED");
	});

	it("leaves a healthy in-flight job alone", async () => {
		const jobId = await startJob();
		await poll("vm-0");

		const result = await reap_jobs(env);
		expect(result).toEqual({ finalised: 0, staleSpawns: 0, abandoned: 0 });

		const job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		expect(job!["STATUS"]).toBe("RUNNING");
	});

	it("closes a stopping job once its agents have gone", async () => {
		const jobId = await startJob();
		const { spawnId } = await poll("vm-0");
		await post("/api/v1/stop", { jobId });
		await env.DB.prepare("UPDATE JOB_SPAWNS SET STATUS = 'STOPPED' WHERE SPAWN_ID = ?").bind(spawnId).run();
		// Keep the job out of the expired-window branch so the STOPPING sweep is
		// what closes it.
		await env.DB.prepare("UPDATE JOBS SET STOP_AT = ? WHERE JOB_ID = ?")
			.bind(Date.now() + 600_000, jobId).run();

		await reap_jobs(env);

		const job = await env.DB.prepare("SELECT STATUS FROM JOBS WHERE JOB_ID = ?").bind(jobId).first();
		expect(job!["STATUS"]).toBe("STOPPED");
	});
});
