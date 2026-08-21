import { agent_poll, UnauthorizedError, verify_agent_token } from "./agents";
import { complete_benchmark_spawn, record_benchmark_metrics } from "./spawn";
import {
    JobsResponse, JobStartRequest, JobStartResponse, JobSummary,
    SpawnCompletionReport, SpawnMetric, SpawnMetricsReport, SpawnStatusRequest,
    WatchRequest, WatchResponse,
} from "./types";

/** Upper bound on agents per job. Not a platform limit, just a guard against
 *  a typo provisioning an absurd fan-out. */
const MAX_AGENTS_PER_JOB = 512;
const DEFAULT_WORKERS_PER_AGENT = 512;
const DEFAULT_START_DELAY_SECONDS = 30;

export async function orchestrator_route(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
        if (request.method === "GET") {
            switch (url.pathname) {
                case "/":
                    return env.ASSETS.fetch(`${url.protocol}//${url.host}/index.html`);
                case "/api/v1/jobs":
                    require_admin(request, env);
                    return Response.json(await list_jobs(env));
                case "/api/v1/config":
                    require_admin(request, env);
                    return Response.json(deployment_config(env));
            }
        }

        if (request.method === "POST") {
            switch (url.pathname) {
                // --- Agent-facing (shared AGENT_TOKEN in the body) ---
                case "/api/agent/poll":
                    return Response.json(await agent_poll(request, env));
                case "/api/internal/spawn-status":
                    return Response.json(await get_internal_job_status(request, env));
                case "/api/internal/spawn-metrics":
                    await record_internal_metrics(request, env);
                    return Response.json({ status: "ok" });
                case "/api/internal/spawn-complete":
                    await complete_internal_spawn(request, env);
                    return Response.json({ status: "ok" });

                // --- Operator-facing ---
                case "/api/v1/start":
                    require_admin(request, env);
                    return Response.json(await start_job(request, env));
                case "/api/v1/watch":
                    require_admin(request, env);
                    return Response.json(await watch_job(request, env));
                case "/api/v1/stop":
                    require_admin(request, env);
                    return Response.json(await stop_job(request, env));
                case "/start": {
                    require_admin(request, env);
                    const jobResponse = await start_job(request, env);
                    if (!jobResponse.jobId) {
                        return new Response(`Failed to start job:\n${JSON.stringify(jobResponse, null, 4)}`, { status: 400 });
                    }
                    return env.ASSETS.fetch(`${url.protocol}//${url.host}/watch.html?jobId=${jobResponse.jobId}`);
                }
            }
        }

        return Response.json({ status: 404, message: "Path not found" }, { status: 404 });
    } catch (error) {
        if (error instanceof UnauthorizedError) {
            return Response.json({ status: "error", message: error.message }, { status: 401 });
        }
        throw error;
    }
}

/**
 * What this deployment was provisioned with, so the UI can default to it.
 *
 * Requesting more agents than exist is not rejected anywhere - the unfilled
 * slots simply never report, and the job runs at a fraction of the requested
 * rate while otherwise looking healthy. Surfacing the real number is the
 * cheapest way to stop that happening by accident.
 */
function deployment_config(env: Env): { provisionedAgents: number | null } {
    const raw = Number(env.DEPLOYMENT_AGENTS);
    return { provisionedAgents: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null };
}

/**
 * Operator authentication.
 *
 * The upstream harness left every endpoint open to the internet, including
 * job start. When ADMIN_TOKEN is unset (local `wrangler dev`) the check is
 * skipped; Terraform always sets it for a deployed environment.
 */
function require_admin(request: Request, env: Env): void {
    const expected = env.ADMIN_TOKEN;
    if (!expected) {
        return;
    }
    const url = new URL(request.url);
    const presented = request.headers.get("x-admin-token") ?? url.searchParams.get("token") ?? "";

    if (presented.length !== expected.length) {
        throw new UnauthorizedError("missing or invalid admin token");
    }
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
    }
    if (diff !== 0) {
        throw new UnauthorizedError("missing or invalid admin token");
    }
}

async function start_job(request: Request, env: Env): Promise<JobStartResponse> {
    const req = await request.json() as JobStartRequest;

    const targetRPS = Math.floor(req.targetRPS);
    const agents = Math.floor(req.agents);
    const workersPerAgent = Math.floor(req.workersPerAgent ?? DEFAULT_WORKERS_PER_AGENT);
    const duration = Math.floor(req.duration);
    const startDelaySeconds = Math.floor(req.startDelaySeconds ?? DEFAULT_START_DELAY_SECONDS);
    const unthrottled = req.unthrottled === true;

    const invalid = (message: string): JobStartResponse =>
        ({ status: "error", message, jobId: undefined, job_request: req });

    for (const [name, value] of Object.entries({ targetRPS, agents, workersPerAgent, duration })) {
        if (!Number.isFinite(value) || value <= 0) {
            return invalid(`${name} must be a positive number`);
        }
    }
    if (!Number.isFinite(startDelaySeconds) || startDelaySeconds < 0) {
        return invalid("startDelaySeconds must be zero or greater");
    }
    if (agents > MAX_AGENTS_PER_JOB) {
        return invalid(`agents must be at most ${MAX_AGENTS_PER_JOB}`);
    }
    if (!unthrottled && targetRPS < agents) {
        return invalid("targetRPS must be at least the number of agents so every agent gets at least 1 RPS");
    }

    // Only one job may be active at a time: agents poll for "the" open job and
    // a second concurrent job would silently steal their slots.
    const active = await env.DB.prepare(
        `SELECT JOB_ID FROM JOBS WHERE STATUS IN ('QUEUED', 'RUNNING', 'STOPPING') LIMIT 1`)
        .first();
    if (active) {
        return invalid(`job ${active["JOB_ID"]} is still active; stop it before starting another`);
    }

    const jobId = crypto.randomUUID();
    const startAt = Date.now() + startDelaySeconds * 1000;
    const stopAt = startAt + duration * 60 * 1000;

    await env.DB.prepare(
        `INSERT INTO JOBS (JOB_ID, RPS, CONCURRENCY, AGENTS, WORKERS_PER_AGENT, DURATION, START_AT, STOP_AT, UNTHROTTLED, STATUS)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED')`)
        .bind(jobId, targetRPS, agents, agents, workersPerAgent, duration, startAt, stopAt, unthrottled ? 1 : 0)
        .run();

    return {
        status: "success",
        message: `Job queued. Load starts in ${startDelaySeconds}s once agents check in.`,
        job_request: req,
        jobId,
    };
}

async function watch_job(request: Request, env: Env): Promise<WatchResponse> {
    const watchRequest = await request.json() as WatchRequest;
    if (!watchRequest.jobId) {
        return { jobId: "unknown", status: "unknown", message: "No JobID provided", metrics: [] };
    }

    const job = await env.DB.prepare(
        `SELECT JOB_ID, STATUS, RPS, AGENTS, DURATION, CREATED_AT FROM JOBS WHERE JOB_ID = ?`)
        .bind(watchRequest.jobId)
        .first();

    if (!job) {
        return { jobId: watchRequest.jobId, status: "unknown", message: "Job ID doesn't exist", metrics: [] };
    }

    const runningAgents = await env.DB.prepare(
        `SELECT COUNT(*) AS COUNT FROM JOB_SPAWNS WHERE JOB_ID = ? AND STATUS = 'RUNNING'`)
        .bind(watchRequest.jobId)
        .first();

    // Latency is averaged weighted by request count: an agent doing 10 RPS
    // must not skew the mean as much as one doing 10,000. The upstream query
    // used an unweighted AVG.
    const rawMetrics = await env.DB.prepare(
        `SELECT CREATED_AT,
                SUM(RPS)                                        AS RPS,
                SUM(ERROR_M1_RATE)                              AS ERROR_M1_RATE,
                SUM(COUNT)                                      AS COUNT,
                SUM(BYTES)                                      AS BYTES,
                COUNT(*)                                        AS WORKER_COUNT,
                CASE WHEN SUM(COUNT) > 0
                     THEN SUM(LATENCY * COUNT) / SUM(COUNT)
                     ELSE AVG(LATENCY) END                      AS LATENCY,
                MAX(P95)                                        AS P95,
                MAX(P99)                                        AS P99
         FROM (
            SELECT SPAWN_ID,
                   strftime('%Y-%m-%d %H:%M:00', CREATED_AT) AS CREATED_AT,
                   AVG(LATENCY)                    AS LATENCY,
                   AVG(RPS)                        AS RPS,
                   AVG(COALESCE(ERROR_M1_RATE, 0)) AS ERROR_M1_RATE,
                   SUM(COUNT)                      AS COUNT,
                   SUM(COALESCE(BYTES, 0))         AS BYTES,
                   MAX(COALESCE(P95, 0))           AS P95,
                   MAX(COALESCE(P99, 0))           AS P99
            FROM JOB_SPAWN_METRICS
            WHERE JOB_ID = ?
            GROUP BY SPAWN_ID, strftime('%Y-%m-%d %H:%M:00', CREATED_AT)
         )
         GROUP BY CREATED_AT
         ORDER BY CREATED_AT DESC
         LIMIT 300`)
        .bind(watchRequest.jobId)
        .all();

    const metrics: SpawnMetric[] = rawMetrics.results.map((row) => ({
        latency: row["LATENCY"] as number,
        rps: row["RPS"] as number,
        errorM1Rate: row["ERROR_M1_RATE"] as number,
        workerCount: row["WORKER_COUNT"] as number,
        createdAt: row["CREATED_AT"] as string,
        p95: row["P95"] as number,
        p99: row["P99"] as number,
        bytes: row["BYTES"] as number,
    }));

    return {
        jobId: watchRequest.jobId,
        status: job["STATUS"] as string,
        created_at: job["CREATED_AT"] as string,
        rps: job["RPS"] as number,
        runningContainers: runningAgents?.["COUNT"] as number | undefined ?? 0,
        metrics,
    };
}

async function list_jobs(env: Env): Promise<JobsResponse> {
    const rawJobs = await env.DB.prepare(
        `SELECT JOB_ID, STATUS, RPS, AGENTS, DURATION, CREATED_AT, UPDATED_AT
         FROM JOBS
         ORDER BY CREATED_AT DESC
         LIMIT 200`)
        .all();

    const jobs: JobSummary[] = rawJobs.results.map((job) => ({
        jobId: job["JOB_ID"] as string,
        status: job["STATUS"] as string,
        rps: job["RPS"] as number,
        concurrency: job["AGENTS"] as number,
        duration: job["DURATION"] as number,
        created_at: job["CREATED_AT"] as string,
        updated_at: job["UPDATED_AT"] as string,
    }));

    return { jobs };
}

/**
 * Request a stop. Agents notice on their next status poll (within ~10s) and
 * wind down; the reaper closes the job out once they have all reported.
 */
async function stop_job(request: Request, env: Env): Promise<{ jobId: string, status: string, message?: string }> {
    const stopRequest = await request.json() as WatchRequest;
    if (!stopRequest.jobId) {
        return { jobId: "unknown", status: "error", message: "No JobID provided" };
    }

    const result = await env.DB.prepare(
        `UPDATE JOBS SET STATUS = 'STOPPING', STOP_AT = ?, UPDATED_AT = current_timestamp
         WHERE JOB_ID = ? AND STATUS NOT IN ('COMPLETED', 'STOPPED', 'FAILED')`)
        .bind(Date.now(), stopRequest.jobId)
        .run();

    return {
        jobId: stopRequest.jobId,
        status: "STOPPING",
        message: result.meta.changes ? "Stop requested; agents wind down within ~10s" : "Job was already finished or does not exist",
    };
}

async function get_internal_job_status(request: Request, env: Env): Promise<{ status: string }> {
    const statusRequest = await request.json() as SpawnStatusRequest;
    verify_internal_request(env, statusRequest);

    const job = await env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`)
        .bind(statusRequest.jobId)
        .first();

    return { status: job?.["STATUS"] as string | undefined ?? "unknown" };
}

async function record_internal_metrics(request: Request, env: Env): Promise<void> {
    const report = await request.json() as SpawnMetricsReport;
    verify_internal_request(env, report);
    await record_benchmark_metrics(env, report);
}

async function complete_internal_spawn(request: Request, env: Env): Promise<void> {
    const report = await request.json() as SpawnCompletionReport;
    verify_internal_request(env, report);
    await complete_benchmark_spawn(env, report);
}

function verify_internal_request(env: Env, data: SpawnStatusRequest): void {
    if (!data?.spawnId || !data?.jobId || !verify_agent_token(env, data?.token)) {
        throw new UnauthorizedError("invalid agent callback token");
    }
}
