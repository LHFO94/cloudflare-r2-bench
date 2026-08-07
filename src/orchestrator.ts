import { JobSpawnRequest, JobStartRequest, JobStartResponse, NoOp, SpawnMetric, WatchRequest, WatchResponse } from "./types";

export async function orchestrator_route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method == "GET") {
        switch (url.pathname) {
            case "/": {
                return env.ASSETS.fetch(`${url.protocol}//${url.host}/index.html`)
            }
        }
    }

    if (request.method == "POST") {
        switch (url.pathname) {
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
            case "/api/v1/start": {
                return Response.json(await start_job(request, env, ctx));
            }
        }
    }

    return Response.json({"status": 404, "message": "Path not found"}, { status: 404 } );
}

async function start_job(request: Request, env: Env, ctx: ExecutionContext<unknown>): Promise<JobStartResponse> {
    const requestJobStart = await request.json() as JobStartRequest;
    if (!requestJobStart.concurrency || !requestJobStart.targetRPS) {
        return {"status": "error", "message": "Invalid request", jobId: undefined, job_request: requestJobStart };
    }

    const jobId = crypto.randomUUID();
    const targetRPSPerJob = requestJobStart.targetRPS / requestJobStart.concurrency;
    const spawnJobs: MessageSendRequest[] = [];
    spawnJobs.push({body: { type: "noop", jobId: jobId} as NoOp, contentType: "json"});

    for (let jobIndex = 0; jobIndex < requestJobStart.concurrency; jobIndex++) {
        const spawnJob: JobSpawnRequest = {
            type: "spawn",
            jobId: jobId,
            targetRPS: targetRPSPerJob,
            jobIndex: jobIndex,
            duration: requestJobStart.duration
        };
        spawnJobs.push({
            body: spawnJob,
            contentType: "json"
        } as MessageSendRequest);
    }
    
    await env.DB.prepare(`INSERT INTO JOBS (JOB_ID, RPS, CONCURRENCY, DURATION, STATUS) VALUES (?, ?, ?, ?, "QUEUED")`)
        .bind(jobId, requestJobStart.targetRPS, requestJobStart.concurrency, requestJobStart.duration, )
        .all();

    while (spawnJobs.length > 0) {
        const subBatch = spawnJobs.splice(0, 50);
        await env.r2bench_spawns.sendBatch(subBatch);
    }
    return {
        "status": "success",
        "message": "Job started succesffuly",
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
    const rawMetrics = await env.DB.prepare(`SELECT AVG(LATENCY) AS LATENCY, SUM(RPS) AS RPS, SUM(COUNT), MIN(CREATED_AT)
             FROM JOB_SPAWN_METRICS
             WHERE JOB_ID = ? 
             GROUP BY JOB_ID, TICK_NUMBER
             ORDER BY TICK_NUMBER DESC 
             LIMIT 300`)
        .bind(watchRequest.jobId)
        .all();

    let metrics: SpawnMetric[] = [];

    for (const rawMetric of rawMetrics.results) {
        const latency = rawMetric['LATENCY'] as number;
        const rps = rawMetric['RPS'] as number;
        const createdAt = rawMetric['CREATED_AT'] as string;

        metrics.push({
            latency,
            rps,
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

