import { JobSpawnRequest, SpawnCompletionReport, SpawnMetricsReport } from "./types";
import type { BenchmarkIterationResult } from "./container";


export async function start_benchmark_container(env: Env, spawnRequest: JobSpawnRequest): Promise<void> {
    const stub = env.BENCHMARK_CONTAINER.getByName(getSpawnId(spawnRequest));
    await stub.startBenchmark(spawnRequest);
}

export async function process_benchmark_spawn_iteration(env: Env, spawnRequest: JobSpawnRequest): Promise<BenchmarkIterationResult> {
    const stub = env.BENCHMARK_CONTAINER.getByName(getSpawnId(spawnRequest));
    return await stub.runBenchmarkIteration(spawnRequest);
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

    await env.DB.prepare(`INSERT INTO JOB_SPAWN_METRICS (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, COUNT) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(metricId, report.spawnId, report.jobId, report.tickNumber, report.latency, report.rps, report.count)
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
