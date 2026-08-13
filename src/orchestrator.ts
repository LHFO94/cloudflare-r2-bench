import { complete_benchmark_spawn, record_benchmark_metrics, stop_benchmark_container, verify_benchmark_container } from "./spawn";
import { JobSpawnRequest, JobStartRequest, JobStartResponse, JobsResponse, JobSummary, SpawnCompletionReport, SpawnMetric, SpawnMetricsReport, SpawnStatusRequest, WatchRequest, WatchResponse } from "./types";

const MAX_CONTAINERS_PER_JOB = 99;

export async function orchestrator_route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method == "GET") {
        switch (url.pathname) {
            case "/": {
                return env.ASSETS.fetch(`${url.protocol}//${url.host}/index.html`)
            }
            case "/api/v1/jobs": {
                return Response.json(await list_jobs(env));
            }
        }
    }

    if (request.method == "POST") {
        switch (url.pathname) {
            case "/api/internal/spawn-status": {
                return Response.json(await get_internal_job_status(request, env));
            }
            case "/api/internal/spawn-metrics": {
                await record_internal_metrics(request, env);
                return Response.json({ status: "ok" });
            }
            case "/api/internal/spawn-complete": {
                await complete_internal_spawn(request, env);
                return Response.json({ status: "ok" });
            }
            case "/start": {
                const jobResponse = await start_job(request, env, ctx);
                if (!jobResponse.jobId) {
                    return new Response(`Failed to start job: \n${JSON.stringify(jobResponse, null, 4)}`)
                }
                return env.ASSETS.fetch(`${url.protocol}//${url.host}/watch.html?jobId=${jobResponse.jobId}`)
            }
            case "/api/v1/watch": {
                const data = await watch_job(request, env, ctx);
                return Response.json(data);
            }
            case "/api/v1/stop": {
                return Response.json(await stop_job(request, env));
            }
            case "/api/v1/start": {
                return Response.json(await start_job(request, env, ctx));
            }
        }
    }

    return Response.json({"status": 404, "message": "Path not found"}, { status: 404 } );
}

async function start_job(request: Request, env: Env, ctx: ExecutionContext<unknown>): Promise<JobStartResponse> {
    const requestJobStart = await request.json() as JobStartRequest;
    const targetRPS = Math.floor(requestJobStart.targetRPS);
    const concurrency = Math.floor(requestJobStart.concurrency);
    const concurrentCallsPerSpawn = Math.floor(requestJobStart.concurrentCallsPerSpawn ?? 10);
    const duration = Math.floor(requestJobStart.duration);

    if (!Number.isFinite(targetRPS) || !Number.isFinite(concurrency) || !Number.isFinite(concurrentCallsPerSpawn) || !Number.isFinite(duration) || targetRPS <= 0 || concurrency <= 0 || concurrentCallsPerSpawn <= 0 || duration <= 0) {
        return {"status": "error", "message": "Invalid request", jobId: undefined, job_request: requestJobStart };
    }
    if (concurrency > MAX_CONTAINERS_PER_JOB) {
        return {"status": "error", "message": `Containers must be less than 100`, jobId: undefined, job_request: requestJobStart };
    }
    if (targetRPS < concurrency) {
        return {"status": "error", "message": "Target RPS must be at least the number of containers", jobId: undefined, job_request: requestJobStart };
    }

    const jobId = crypto.randomUUID();

    const baseTargetRPSPerJob = Math.floor(targetRPS / concurrency);
    const extraRPSJobs = targetRPS % concurrency;
    const spawnJobs: JobSpawnRequest[] = [];

    for (let jobIndex = 0; jobIndex < concurrency; jobIndex++) {
        const spawnJob: JobSpawnRequest = {
            type: "spawn",
            jobId: jobId,
            targetRPS: baseTargetRPSPerJob + (jobIndex < extraRPSJobs ? 1 : 0),
            jobIndex: jobIndex,
            concurrentCallsPerSpawn,
            duration
        };
        spawnJobs.push(spawnJob);
    }
    
    await env.DB.prepare(`INSERT INTO JOBS (JOB_ID, RPS, CONCURRENCY, DURATION, STATUS) VALUES (?, ?, ?, ?, "QUEUED")`)
        .bind(jobId, targetRPS, concurrency, duration, )
        .all();

    try {
        await env.r2bench_spawns.sendBatch(spawnJobs.map((spawnJob) => ({ body: spawnJob })));
    } catch (error) {
        await env.DB.prepare(`UPDATE JOBS SET STATUS = 'FAILED' WHERE JOB_ID = ?`)
            .bind(jobId)
            .run();

        return {
            "status": "error",
            "message": `Failed to queue benchmark containers for job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
            "job_request": requestJobStart,
        };
    }

    return {
        "status": "success",
        "message": "Job queued succesffuly",
        "job_request": requestJobStart,
        jobId: jobId
    }
}
async function watch_job(request: Request<unknown, CfProperties<unknown>>, env: Env, ctx: ExecutionContext<unknown>): Promise<WatchResponse> {
    const watchRequest = await request.json() as WatchRequest;
    if (!watchRequest.jobId) {
        return { jobId: "unknown", status: "unknown", message: "No JobID provided", metrics: [] };
    }

    const job = await env.DB.prepare(`SELECT JOB_ID, STATUS, RPS, CONCURRENCY, DURATION, CREATED_AT, STATUS FROM JOBS WHERE JOB_ID = ?`)
        .bind(watchRequest.jobId)
        .first();

    if (!job) {
        return { jobId: watchRequest.jobId, status: "unknown", message: "Job ID doesn't exist", metrics: [] };
    }
    const rawMetrics = await env.DB.prepare(`SELECT AVG(LATENCY) AS LATENCY, SUM(RPS) AS RPS, SUM(ERROR_M1_RATE) AS ERROR_M1_RATE, SUM(COUNT) AS COUNT, CREATED_AT
             FROM (
                SELECT SPAWN_ID, AVG(LATENCY) AS LATENCY, AVG(RPS) AS RPS, AVG(COALESCE(ERROR_M1_RATE, 0)) AS ERROR_M1_RATE, SUM(COUNT) AS COUNT, strftime('%Y-%m-%d %H:%M:00', CREATED_AT) AS CREATED_AT
                FROM JOB_SPAWN_METRICS
                WHERE JOB_ID = ? AND CREATED_AT < strftime('%Y-%m-%d %H:%M:00', 'now')
                GROUP BY SPAWN_ID, strftime('%Y-%m-%d %H:%M:00', CREATED_AT)
             )
             GROUP BY CREATED_AT
             ORDER BY CREATED_AT DESC
             LIMIT 300`)
        .bind(watchRequest.jobId)
        .all();

    let metrics: SpawnMetric[] = [];

    for (const rawMetric of rawMetrics.results) {
        const latency = rawMetric['LATENCY'] as number;
        const rps = rawMetric['RPS'] as number;
        const errorM1Rate = rawMetric['ERROR_M1_RATE'] as number;
        const createdAt = rawMetric['CREATED_AT'] as string;

        metrics.push({
            latency,
            rps,
            errorM1Rate,
            createdAt
        })
    }

    return {
        jobId: watchRequest.jobId,
        status: job['STATUS'] as string,
        created_at: job['CREATED_AT'] as string,
        latency: job['LATENCY'] as number,
        rps: job['RPS'] as number,
        metrics
    }
}

async function list_jobs(env: Env): Promise<JobsResponse> {
    const rawJobs = await env.DB.prepare(`SELECT JOB_ID, STATUS, RPS, CONCURRENCY, DURATION, CREATED_AT, UPDATED_AT
             FROM JOBS
             ORDER BY CREATED_AT DESC
             LIMIT 200`)
        .all();

    const jobs: JobSummary[] = rawJobs.results.map((job) => ({
        jobId: job['JOB_ID'] as string,
        status: job['STATUS'] as string,
        rps: job['RPS'] as number,
        concurrency: job['CONCURRENCY'] as number,
        duration: job['DURATION'] as number,
        created_at: job['CREATED_AT'] as string,
        updated_at: job['UPDATED_AT'] as string,
    }));

    return { jobs };
}

async function stop_job(request: Request, env: Env): Promise<{ jobId: string, status: string, message?: string }> {
    const stopRequest = await request.json() as WatchRequest;
    if (!stopRequest.jobId) {
        return { jobId: "unknown", status: "error", message: "No JobID provided" };
    }

    const job = await env.DB.prepare(`SELECT CONCURRENCY FROM JOBS WHERE JOB_ID = ?`)
        .bind(stopRequest.jobId)
        .first();

    const result = await env.DB.prepare(`UPDATE JOBS SET STATUS = 'STOPPING' WHERE JOB_ID = ? AND STATUS NOT IN ('COMPLETED', 'STOPPED', 'FAILED')`)
        .bind(stopRequest.jobId)
        .run();

    const concurrency = job?.['CONCURRENCY'] as number | undefined;
    if (concurrency) {
        await Promise.all(Array.from({ length: concurrency }, (_, jobIndex) => stop_benchmark_container(env, stopRequest.jobId, jobIndex)));
    }

    return {
        jobId: stopRequest.jobId,
        status: "STOPPING",
        message: result.meta.changes ? "Stop requested" : "Job was already finished or does not exist",
    };
}

async function get_internal_job_status(request: Request, env: Env): Promise<{ status: string }> {
    const statusRequest = await request.json() as SpawnStatusRequest;
    await verify_internal_request(env, statusRequest);

    const job = await env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`)
        .bind(statusRequest.jobId)
        .first();

    return { status: job?.['STATUS'] as string | undefined ?? "unknown" };
}

async function record_internal_metrics(request: Request, env: Env): Promise<void> {
    const metricsReport = await request.json() as SpawnMetricsReport;
    await verify_internal_request(env, metricsReport);
    await record_benchmark_metrics(env, metricsReport);
}

async function complete_internal_spawn(request: Request, env: Env): Promise<void> {
    const completionReport = await request.json() as SpawnCompletionReport;
    await verify_internal_request(env, completionReport);
    await complete_benchmark_spawn(env, completionReport);
}

async function verify_internal_request(env: Env, data: SpawnStatusRequest): Promise<void> {
    if (!data.spawnId || !data.token || !await verify_benchmark_container(env, data.spawnId, data.token)) {
        throw new Error("Invalid benchmark container callback token");
    }
}
