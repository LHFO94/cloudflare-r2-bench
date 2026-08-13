import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { getBenchmarkStopAt } from "../src/container";
import { process_benchmark_job_iteration } from "../src/spawn";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

async function ensureTables() {
	await env.DB.prepare(`CREATE TABLE IF NOT EXISTS JOBS(
		JOB_ID STRING PRIMARY KEY,
		RPS NUMBER,
		CONCURRENCY NUMBER,
		DURATION NUMBER,
		STATUS TEXT,
		CREATED_AT TEXT NOT NULL DEFAULT current_timestamp,
		UPDATED_AT TEXT NOT NULL DEFAULT current_timestamp
	)`).run();
	await env.DB.prepare(`CREATE TABLE IF NOT EXISTS JOB_SPAWNS(
		SPAWN_ID STRING PRIMARY KEY,
		JOB_ID STRING,
		STATUS TEXT,
		AVG_LATENCY NUMBER,
		AVG_RPS NUMBER,
		COUNT NUMBER,
		CREATED_AT TEXT NOT NULL DEFAULT current_timestamp,
		UPDATED_AT TEXT NOT NULL DEFAULT current_timestamp
	)`).run();
	await env.DB.prepare(`CREATE TABLE IF NOT EXISTS JOB_SPAWN_METRICS(
		METRIC_ID STRING PRIMARY KEY,
		TICK_NUMBER NUMBER DEFAULT 0,
		SPAWN_ID STRING KEY,
		JOB_ID STRING,
		LATENCY NUMBER,
		RPS NUMBER,
		COUNT NUMBER,
		ERROR_M1_RATE NUMBER,
		CREATED_AT TEXT NOT NULL DEFAULT current_timestamp
	)`).run();
}

describe("R2 benchmark worker", () => {
	it("serves the landing page (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("R2 benchmark");
	});

	it("serves the landing page (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("R2 benchmark");
	});

	it("reports running containers in watch response", async () => {
		await ensureTables();

		const jobId = crypto.randomUUID();
		await env.DB.prepare(`INSERT INTO JOBS (JOB_ID, RPS, CONCURRENCY, DURATION, STATUS) VALUES (?, ?, ?, ?, ?)`)
			.bind(jobId, 100, 3, 5, "RUNNING")
			.run();
		await Promise.all([
			env.DB.prepare(`INSERT INTO JOB_SPAWNS (SPAWN_ID, JOB_ID, STATUS) VALUES (?, ?, ?)`)
				.bind(`${jobId}-0`, jobId, "RUNNING")
				.run(),
			env.DB.prepare(`INSERT INTO JOB_SPAWNS (SPAWN_ID, JOB_ID, STATUS) VALUES (?, ?, ?)`)
				.bind(`${jobId}-1`, jobId, "RUNNING")
				.run(),
			env.DB.prepare(`INSERT INTO JOB_SPAWNS (SPAWN_ID, JOB_ID, STATUS) VALUES (?, ?, ?)`)
				.bind(`${jobId}-2`, jobId, "COMPLETED")
				.run(),
		]);
		await Promise.all([
			env.DB.prepare(`INSERT INTO JOB_SPAWN_METRICS (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, COUNT, ERROR_M1_RATE, CREATED_AT) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(`${jobId}-metric-0`, `${jobId}-0`, jobId, 0, 10, 20, 5, 0, "2026-01-01 00:00:10")
				.run(),
			env.DB.prepare(`INSERT INTO JOB_SPAWN_METRICS (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, COUNT, ERROR_M1_RATE, CREATED_AT) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(`${jobId}-metric-1`, `${jobId}-0`, jobId, 1, 20, 30, 6, 0, "2026-01-01 00:00:20")
				.run(),
			env.DB.prepare(`INSERT INTO JOB_SPAWN_METRICS (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, COUNT, ERROR_M1_RATE, CREATED_AT) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(`${jobId}-metric-2`, `${jobId}-1`, jobId, 0, 30, 40, 7, 0, "2026-01-01 00:00:30")
				.run(),
		]);

		const request = new IncomingRequest("http://example.com/api/v1/watch", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jobId }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = await response.json() as { metrics: Array<{ workerCount: number }> };
		expect(data).toMatchObject({
			jobId,
			status: "RUNNING",
			runningContainers: 2,
		});
		expect(data.metrics[0].workerCount).toBe(2);
	});

	it("calculates benchmark stop time from the job start", () => {
		expect(getBenchmarkStopAt({
			type: "spawn",
			jobId: "job-1",
			jobIndex: 3,
			targetRPS: 10,
			concurrentCallsPerSpawn: 1,
			duration: 7,
			jobStartedAt: 1_000,
		})).toBe(421_000);
	});

	it("does not start pending spawns after the job deadline", async () => {
		await ensureTables();
		const jobId = crypto.randomUUID();
		await env.DB.prepare(`INSERT INTO JOBS (JOB_ID, RPS, CONCURRENCY, DURATION, STATUS) VALUES (?, ?, ?, ?, ?)`)
			.bind(jobId, 100, 1, 1, "RUNNING")
			.run();

		const result = await process_benchmark_job_iteration(env, {
			type: "monitor_job",
			jobId,
			nextSpawnIndex: 0,
			spawns: [{
				type: "spawn",
				jobId,
				jobIndex: 0,
				targetRPS: 100,
				concurrentCallsPerSpawn: 10,
				duration: 1,
				jobStartedAt: Date.now() - 61_000,
			}],
		});

		const spawns = await env.DB.prepare(`SELECT COUNT(*) AS COUNT FROM JOB_SPAWNS WHERE JOB_ID = ?`)
			.bind(jobId)
			.first();
		const job = await env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`)
			.bind(jobId)
			.first();

		expect(result.continue).toBe(false);
		expect(spawns?.['COUNT']).toBe(0);
		expect(job?.['STATUS']).toBe("COMPLETED");
	});
});
