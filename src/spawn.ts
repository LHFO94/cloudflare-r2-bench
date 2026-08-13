import { JobMonitorRequest, JobSpawnRequest, SpawnCompletionReport, SpawnMetricsReport } from "./types";
import type { BenchmarkIterationResult } from "./container";


export async function start_benchmark_container(env: Env, spawnRequest: JobSpawnRequest): Promise<void> {
    const stub = env.BENCHMARK_CONTAINER.getByName(getSpawnId(spawnRequest));
    await stub.startBenchmark(spawnRequest);
}

const CONTAINER_START_DELAY_SECONDS = 5;
const MAX_CONTAINER_START_RETRIES = 5;

export async function process_benchmark_job_iteration(env: Env, request: JobMonitorRequest): Promise<BenchmarkIterationResult> {
    const jobId = request.jobId;
    const job = await env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`)
        .bind(jobId)
        .first();
    const jobStatus = job?.['STATUS'] as string | undefined;

    if (!job) {
        return { continue: false };
    }

    let allSpawns = await get_job_spawns(env, jobId);
    let rawSpawns = get_running_spawns(allSpawns);

    if (['COMPLETED', 'STOPPED', 'FAILED'].includes(jobStatus ?? '')) {
        await Promise.all(rawSpawns.results.map(async (spawn) => {
            const spawnId = spawn['SPAWN_ID'] as string;
            const stub = env.BENCHMARK_CONTAINER.getByName(spawnId);
            await stub.runStoredBenchmarkIteration();
        }));

        return { continue: false };
    }

    const spawns = request.spawns ?? [];
    const startRetryCounts = { ...(request.startRetryCounts ?? {}) };
    let nextSpawnIndex = request.nextSpawnIndex ?? spawns.length;
    const existingSpawnIds = new Set(allSpawns.results.map((spawn) => spawn['SPAWN_ID'] as string));

    if (spawns[0] && Date.now() >= getJobStopAt(spawns[0])) {
        await Promise.all(rawSpawns.results.map(async (spawn) => {
            const spawnId = spawn['SPAWN_ID'] as string;
            const stub = env.BENCHMARK_CONTAINER.getByName(spawnId);
            await stub.runStoredBenchmarkIteration();
        }));

        if (rawSpawns.results.length === 0) {
            await env.DB.prepare(`UPDATE JOBS SET STATUS = 'COMPLETED' WHERE JOB_ID = ? AND STATUS IN ('QUEUED', 'RUNNING')`)
                .bind(jobId)
                .run();
        }

        return { continue: false };
    }

    while (nextSpawnIndex < spawns.length && existingSpawnIds.has(getSpawnId(spawns[nextSpawnIndex]))) {
        nextSpawnIndex += 1;
    }

    if (!['STOPPING', 'STOPPED'].includes(jobStatus ?? '') && nextSpawnIndex < spawns.length) {
        const spawnRequest = spawns[nextSpawnIndex];
        if (spawnRequest.jobId !== jobId || spawnRequest.jobIndex !== nextSpawnIndex) {
            throw new Error("Invalid job monitor spawn request");
        }

        const spawnId = getSpawnId(spawnRequest);
        try {
            await start_benchmark_container(env, spawnRequest);
            delete startRetryCounts[spawnId];
            nextSpawnIndex += 1;
            allSpawns = await get_job_spawns(env, jobId);
            rawSpawns = get_running_spawns(allSpawns);
        } catch (error) {
            const retryCount = (startRetryCounts[spawnId] ?? 0) + 1;
            startRetryCounts[spawnId] = retryCount;
            console.warn(`Failed to start container ${spawnId} on attempt ${retryCount}/${MAX_CONTAINER_START_RETRIES}: ${error instanceof Error ? error.message : String(error)}`);

            if (retryCount >= MAX_CONTAINER_START_RETRIES) {
                await fail_job_and_stop_spawns(env, jobId, rawSpawns);
                return { continue: false };
            }

            return {
                continue: true,
                delaySeconds: CONTAINER_START_DELAY_SECONDS,
                nextSpawnIndex,
                startRetryCounts,
            };
        }
    }

    if (rawSpawns.results.length === 0) {
        if (nextSpawnIndex < spawns.length || ['QUEUED', 'RUNNING', 'STOPPING'].includes(jobStatus ?? '')) {
            return { continue: true, delaySeconds: CONTAINER_START_DELAY_SECONDS, nextSpawnIndex, startRetryCounts };
        }

        return { continue: false };
    }

    const results = await Promise.all(rawSpawns.results.map(async (spawn) => {
        const spawnId = spawn['SPAWN_ID'] as string;
        const stub = env.BENCHMARK_CONTAINER.getByName(spawnId);
        return await stub.runStoredBenchmarkIteration();
    }));

    const activeResults = results.filter((result) => result.continue);
    if (activeResults.length === 0 && nextSpawnIndex >= spawns.length) {
        return { continue: false };
    }

    return {
        continue: true,
        delaySeconds: nextSpawnIndex < spawns.length ? CONTAINER_START_DELAY_SECONDS : Math.min(...activeResults.map((result) => result.delaySeconds ?? 10)),
        nextSpawnIndex,
        startRetryCounts,
    };
}

async function get_job_spawns(env: Env, jobId: string): Promise<D1Result<Record<string, unknown>>> {
    return await env.DB.prepare(`SELECT SPAWN_ID, STATUS FROM JOB_SPAWNS WHERE JOB_ID = ? ORDER BY SPAWN_ID`)
        .bind(jobId)
        .all();
}

function get_running_spawns(spawns: D1Result<Record<string, unknown>>): D1Result<Record<string, unknown>> {
    return {
        ...spawns,
        results: spawns.results.filter((spawn) => spawn['STATUS'] === 'RUNNING'),
    };
}

async function fail_job_and_stop_spawns(env: Env, jobId: string, rawSpawns: D1Result<Record<string, unknown>>): Promise<void> {
    await env.DB.prepare(`UPDATE JOBS SET STATUS = 'FAILED' WHERE JOB_ID = ?`)
        .bind(jobId)
        .run();

    await Promise.all(rawSpawns.results.map(async (spawn) => {
        const spawnId = spawn['SPAWN_ID'] as string;
        const stub = env.BENCHMARK_CONTAINER.getByName(spawnId);
        await stub.runStoredBenchmarkIteration();
    }));
}

export async function stop_benchmark_container(env: Env, jobId: string, jobIndex: number): Promise<void> {
    const stub = env.BENCHMARK_CONTAINER.getByName(`${jobId}-${jobIndex}`);
    await stub.stopBenchmark();
}

export async function verify_benchmark_container(env: Env, spawnId: string, token: string): Promise<boolean> {
    const stub = env.BENCHMARK_CONTAINER.getByName(spawnId);
    return await stub.validateToken(token);
}

export async function record_benchmark_metrics(env: Env, report: SpawnMetricsReport): Promise<void> {
    const metricId = `${report.spawnId}-${Date.now()}`;

    await env.DB.prepare(`INSERT INTO JOB_SPAWN_METRICS (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, ERROR_M1_RATE, COUNT) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(metricId, report.spawnId, report.jobId, report.tickNumber, report.latency, report.rps, report.errorM1Rate ?? 0, report.count)
        .run();

    await env.DB.prepare(`UPDATE JOB_SPAWNS SET AVG_LATENCY = ?, AVG_RPS = ?, COUNT = ? WHERE SPAWN_ID = ?`)
        .bind(report.avgLatency, report.actualRPS, report.totalCount, report.spawnId)
        .run();
}

export async function complete_benchmark_spawn(env: Env, report: SpawnCompletionReport): Promise<void> {
    if (report.error) {
        await env.DB.prepare(`UPDATE JOB_SPAWNS SET STATUS = 'FAILED' WHERE SPAWN_ID = ?`)
            .bind(report.spawnId)
            .run();

        await env.DB.prepare(`UPDATE JOBS SET STATUS = 'FAILED' WHERE JOB_ID = ?`)
            .bind(report.jobId)
            .run();
        return;
    }

    const job = await env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`)
        .bind(report.jobId)
        .first();
    const jobStatus = job?.['STATUS'] as string | undefined;
    const finalSpawnStatus = ['STOPPING', 'STOPPED'].includes(jobStatus ?? '') ? 'STOPPED' : 'COMPLETED';

    await env.DB.prepare(`UPDATE JOB_SPAWNS SET STATUS = ? WHERE SPAWN_ID = ?`)
        .bind(finalSpawnStatus, report.spawnId)
        .run();

    const activeSpawns = await env.DB.prepare(`
           SELECT COUNT(*) AS COUNT
           FROM JOB_SPAWNS
           WHERE JOB_ID = ? AND STATUS = 'RUNNING'`)
        .bind(report.jobId)
        .first();

    if ((activeSpawns?.['COUNT'] as number | undefined) !== 0) {
        return;
    }

    await env.DB.prepare(`UPDATE JOBS SET STATUS = ? WHERE JOB_ID = ?`)
        .bind(['STOPPING', 'STOPPED'].includes(jobStatus ?? '') ? 'STOPPED' : 'COMPLETED', report.jobId)
        .run();
}

function getSpawnId(spawnRequest: JobSpawnRequest): string {
    return `${spawnRequest.jobId}-${spawnRequest.jobIndex}`;
}

function getJobStopAt(spawnRequest: JobSpawnRequest): number {
    return spawnRequest.jobStartedAt + spawnRequest.duration * 60 * 1000;
}
