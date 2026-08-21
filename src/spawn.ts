import { SpawnCompletionReport, SpawnMetricsReport } from "./types";

/**
 * A spawn that has not reported in this long is presumed dead (VM preempted,
 * agent crashed, network partition). Agents report every 10s by default, so
 * this allows six missed reports before intervening.
 */
const SPAWN_STALE_AFTER_MS = 90_000;

/**
 * Grace period after a job's stop time before the reaper finalises it, giving
 * agents a chance to deliver their final metrics flush and completion report.
 */
const JOB_FINALISE_GRACE_MS = 30_000;

/**
 * How long a job may sit QUEUED with no agents before being failed. If the
 * VMs are not running or the token is wrong, this is what surfaces it rather
 * than leaving the job pending forever.
 */
const QUEUED_WITHOUT_AGENTS_TIMEOUT_MS = 300_000;

/**
 * Persist an interval metrics report from an agent.
 *
 * Both statements are sent as a single D1 batch: at 8 agents on a 10s cadence
 * this is only ~1.6 writes/sec, but batching keeps the round trips down and
 * makes the pair atomic.
 */
export async function record_benchmark_metrics(env: Env, report: SpawnMetricsReport): Promise<void> {
    // crypto.randomUUID rather than `${spawnId}-${Date.now()}`: the original
    // scheme collides if a spawn reports twice within the same millisecond.
    const metricId = crypto.randomUUID();

    await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO JOB_SPAWN_METRICS
               (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, ERROR_M1_RATE, COUNT,
                P50, P95, P99, BYTES, STATUS_4XX, STATUS_5XX)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(
                metricId, report.spawnId, report.jobId, report.tickNumber,
                report.latency, report.rps, report.errorM1Rate ?? 0, report.count,
                report.p50 ?? 0, report.p95 ?? 0, report.p99 ?? 0,
                report.bytes ?? 0, report.status4xx ?? 0, report.status5xx ?? 0),
        env.DB.prepare(
            `UPDATE JOB_SPAWNS
             SET AVG_LATENCY = ?, AVG_RPS = ?, COUNT = ?, LAST_SEEN = ?, UPDATED_AT = current_timestamp
             WHERE SPAWN_ID = ?`)
            .bind(report.avgLatency, report.actualRPS, report.totalCount, Date.now(), report.spawnId),
    ]);
}

/** Record an agent finishing, and close out the job once the last one lands. */
export async function complete_benchmark_spawn(env: Env, report: SpawnCompletionReport): Promise<void> {
    if (report.error) {
        await env.DB.batch([
            env.DB.prepare(`UPDATE JOB_SPAWNS SET STATUS = 'FAILED', UPDATED_AT = current_timestamp WHERE SPAWN_ID = ?`)
                .bind(report.spawnId),
            env.DB.prepare(`UPDATE JOBS SET STATUS = 'FAILED', UPDATED_AT = current_timestamp WHERE JOB_ID = ? AND STATUS IN ('QUEUED', 'RUNNING')`)
                .bind(report.jobId),
        ]);
        return;
    }

    const job = await env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`)
        .bind(report.jobId)
        .first();
    const jobStatus = job?.["STATUS"] as string | undefined;
    const stopping = ["STOPPING", "STOPPED"].includes(jobStatus ?? "");

    await env.DB.prepare(`UPDATE JOB_SPAWNS SET STATUS = ?, UPDATED_AT = current_timestamp WHERE SPAWN_ID = ?`)
        .bind(stopping ? "STOPPED" : "COMPLETED", report.spawnId)
        .run();

    const active = await env.DB.prepare(
        `SELECT COUNT(*) AS COUNT FROM JOB_SPAWNS WHERE JOB_ID = ? AND STATUS = 'RUNNING'`)
        .bind(report.jobId)
        .first();

    if ((active?.["COUNT"] as number | undefined) !== 0) {
        return;
    }

    await env.DB.prepare(
        `UPDATE JOBS SET STATUS = ?, UPDATED_AT = current_timestamp
         WHERE JOB_ID = ? AND STATUS IN ('QUEUED', 'RUNNING', 'STOPPING')`)
        .bind(stopping ? "STOPPED" : "COMPLETED", report.jobId)
        .run();
}

/**
 * Scheduled reconciliation, invoked by the cron trigger.
 *
 * The original harness drove each job from a single self-perpetuating queue
 * message; if that message was ever lost the job hung in RUNNING forever with
 * nothing to advance it. A cron sweep is stateless and idempotent, so a missed
 * tick simply resolves on the next minute.
 */
export async function reap_jobs(env: Env): Promise<{ finalised: number, staleSpawns: number, abandoned: number }> {
    const now = Date.now();
    let finalised = 0;
    let staleSpawns = 0;
    let abandoned = 0;

    // 1. Mark spawns that have stopped reporting. Without this a dead VM keeps
    //    a job RUNNING indefinitely because its spawn never completes.
    const stale = await env.DB.prepare(
        `UPDATE JOB_SPAWNS SET STATUS = 'FAILED', UPDATED_AT = current_timestamp
         WHERE STATUS = 'RUNNING' AND LAST_SEEN IS NOT NULL AND LAST_SEEN < ?`)
        .bind(now - SPAWN_STALE_AFTER_MS)
        .run();
    staleSpawns = stale.meta.changes ?? 0;

    // 2. Finalise jobs whose window has closed.
    const expired = await env.DB.prepare(
        `SELECT JOB_ID FROM JOBS WHERE STATUS IN ('QUEUED', 'RUNNING', 'STOPPING') AND STOP_AT < ?`)
        .bind(now - JOB_FINALISE_GRACE_MS)
        .all();

    for (const row of expired.results) {
        const jobId = row["JOB_ID"] as string;

        // A job whose window closed without a single agent ever registering did
        // not complete, it failed. Reporting COMPLETED with no metrics invites
        // the reader to treat missing data as a UI glitch rather than a run
        // that never happened. Rule 3 below also catches this, but only after
        // five minutes, so any job shorter than that would be finalised here
        // first and mislabelled purely because of its duration.
        const spawned = await env.DB.prepare(
            `SELECT COUNT(*) AS COUNT FROM JOB_SPAWNS WHERE JOB_ID = ?`)
            .bind(jobId)
            .first<{ COUNT: number }>();
        const outcome = (spawned?.COUNT ?? 0) > 0 ? "COMPLETED" : "FAILED";

        await env.DB.batch([
            env.DB.prepare(
                `UPDATE JOB_SPAWNS SET STATUS = 'COMPLETED', UPDATED_AT = current_timestamp
                 WHERE JOB_ID = ? AND STATUS = 'RUNNING'`)
                .bind(jobId),
            env.DB.prepare(
                `UPDATE JOBS SET STATUS = ?, UPDATED_AT = current_timestamp
                 WHERE JOB_ID = ? AND STATUS IN ('QUEUED', 'RUNNING', 'STOPPING')`)
                .bind(outcome, jobId),
        ]);
        finalised++;
    }

    // 3. Fail jobs that never attracted any agents, so a misconfigured fleet
    //    is visible in the UI instead of hanging.
    const orphaned = await env.DB.prepare(
        `UPDATE JOBS SET STATUS = 'FAILED', UPDATED_AT = current_timestamp
         WHERE STATUS = 'QUEUED'
           AND START_AT < ?
           AND (SELECT COUNT(*) FROM JOB_SPAWNS WHERE JOB_SPAWNS.JOB_ID = JOBS.JOB_ID) = 0`)
        .bind(now - QUEUED_WITHOUT_AGENTS_TIMEOUT_MS)
        .run();
    abandoned = orphaned.meta.changes ?? 0;

    // 4. Close out stopping jobs once every agent has gone quiet.
    await env.DB.prepare(
        `UPDATE JOBS SET STATUS = 'STOPPED', UPDATED_AT = current_timestamp
         WHERE STATUS = 'STOPPING'
           AND (SELECT COUNT(*) FROM JOB_SPAWNS WHERE JOB_SPAWNS.JOB_ID = JOBS.JOB_ID AND STATUS = 'RUNNING') = 0`)
        .run();

    return { finalised, staleSpawns, abandoned };
}
