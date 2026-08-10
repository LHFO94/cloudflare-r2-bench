import { JobSpawnContinue, JobSpawnRequest, SpawnStatus } from "./types";

const MAX_PARALLEL_R2_GETS = 6;
const R2_OBJECT_KEY = '/bench.tar';

export async function continue_bench(spawnid: string, spawnRequest: JobSpawnRequest, env: Env, spawnStatus?: SpawnStatus) {
    if (!spawnStatus) {
        spawnStatus = {
            spawnId: spawnid,
            startedAt: new Date().getTime(),
            lastStatusCheck: new Date().getTime(),
            lastD1Update: new Date().getTime(),
            duration: 0,
            count: 0,
            actualRPS: 0,
            totalLatency: 0,
            avgLatency: 0,
            tenCount: 0,
            tenTotalLatency: 0,
            tenTick: 0,
        } as SpawnStatus;

        await env.DB.prepare(`INSERT INTO JOB_SPAWNS (SPAWN_ID, JOB_ID, STATUS) VALUES (?, ?, 'RUNNING')
        ON CONFLICT (SPAWN_ID) DO UPDATE SET CREATED_AT = EXCLUDED.CREATED_AT`)
            .bind(spawnid, spawnRequest.jobId)
            .all();
    }

    while (true) {
        if (await shouldStop(spawnStatus, spawnRequest, env)) {
            break;
        }

        const batchSize = getR2BatchSize(spawnRequest.targetRPS, spawnStatus.avgLatency);
        const batchStartedAt = new Date().getTime();
        const results = await Promise.all(Array.from({ length: batchSize }, () => getR2Latency(env)));
        const now = new Date().getTime();

        for (const result of results) {
            if (!result.ok) {
                console.error(`Failed fetching R2 data, error: ${result.error}`);
            }

            spawnStatus.count += 1;
            spawnStatus.tenCount += 1;
            spawnStatus.totalLatency += result.latency;
            spawnStatus.tenTotalLatency += result.latency;
        }

        spawnStatus.duration = now - spawnStatus.startedAt;
        spawnStatus.actualRPS = spawnStatus.duration < 1000 ? spawnStatus.count : (spawnStatus.count / (spawnStatus.duration / 1000))
        spawnStatus.avgLatency = spawnStatus.totalLatency / spawnStatus.count;

        if (await maybeUpdateD1(spawnStatus, spawnRequest, env)) {
            // Quiting the workers right now and sending a message into the queue to continue
            const continueMessage: JobSpawnContinue = {
                type: "spawn_continue",
                request: spawnRequest,
                status: spawnStatus,
            }
            await env.r2bench_spawns.send(continueMessage);
            break;
        }

        const targetBatchDuration = Math.ceil((batchSize / spawnRequest.targetRPS) * 1000);
        const estimatedSleep = targetBatchDuration - (now - batchStartedAt) - 1;
        if (estimatedSleep <= 0 && batchSize === MAX_PARALLEL_R2_GETS) {
            console.warn(`R2 latency too high (${Math.ceil(spawnStatus.avgLatency)}ms), can't match target RPS (${spawnRequest.targetRPS}) with ${MAX_PARALLEL_R2_GETS} parallel gets`)
        } else {
            await sleep(Math.max(estimatedSleep, 0));
        }
    }

    if (await shouldStop(spawnStatus, spawnRequest, env)) {
        await updateD1AfterSpawnCompletion(env, spawnStatus, spawnRequest);
    }
}

async function updateD1AfterSpawnCompletion(env: Env, spawnStatus: SpawnStatus, spawnRequest: JobSpawnRequest) {
    const job = await env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`)
        .bind(spawnRequest.jobId)
        .first();
    const jobStatus = job?.['STATUS'] as string | undefined;
    const finalSpawnStatus = jobStatus === 'STOPPING' ? 'STOPPED' : 'COMPLETED';

    await env.DB.prepare(`UPDATE JOB_SPAWNS SET STATUS = ? WHERE SPAWN_ID = ?`)
        .bind(finalSpawnStatus, spawnStatus.spawnId)
        .run();

    const activeSpawns = await env.DB.prepare(`
           SELECT COUNT(*) AS COUNT
           FROM JOB_SPAWNS
           WHERE JOB_ID = ? AND STATUS = 'RUNNING'`)
        .bind(spawnRequest.jobId)
        .first();

    if ((activeSpawns?.['COUNT'] as number | undefined) !== 0) {
        return;
    }

    await env.DB.prepare(`UPDATE JOBS SET STATUS = ? WHERE JOB_ID = ?`)
        .bind(jobStatus === 'STOPPING' ? 'STOPPED' : 'COMPLETED', spawnRequest.jobId)
        .run();
}

export async function spawn_job(spawnRequest: JobSpawnRequest, env: Env, ctx: ExecutionContext<unknown>) {
    await env.DB.prepare(`UPDATE JOBS SET STATUS = 'RUNNING' WHERE JOB_ID = ? AND STATUS = 'QUEUED'`).bind(spawnRequest.jobId).run();
    const spawnId = `${spawnRequest.jobId}-${spawnRequest.jobIndex}}`;
    ctx.waitUntil(continue_bench(spawnId, spawnRequest, env));
}

async function shouldStop(status: SpawnStatus, spawnRequest: JobSpawnRequest, env: Env) {
    const now = new Date().getTime();
    if ((now - status.startedAt) >= (spawnRequest.duration * 60 * 1000)) {
        return true;
    }

    if ((now - status.lastStatusCheck) >= (15 * 1000)) {
        status.lastStatusCheck = now;
        const res = await env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`).bind(spawnRequest.jobId).first();
        if (!res) {
            console.warn(`Error while checking status for JOB ${spawnRequest.jobId}. No data found in D1`);
        } else {
            const status = res['STATUS'] as string;
            if (['STOPPED', 'STOPPING', 'FAILED'].includes(status)) {
                return true;
            }
        }
    }
    return false;
}

async function maybeUpdateD1(status: SpawnStatus, spawnRequest: JobSpawnRequest, env: Env): Promise<boolean> {
    const now = new Date().getTime();
    if ((now - status.lastD1Update) < (10 * 1000)) {
        return false;
    }

    const id = `${status.spawnId}-${now}`
    const avgLatency = status.tenTotalLatency / status.tenCount;
    const rps = status.tenCount / ((now - status.lastD1Update) / 1000)

    console.info(`Updating spawn metrics (${id})\n\tlatency: ${avgLatency}\n\trps: ${rps}`)

    await env.DB.prepare(`INSERT INTO JOB_SPAWN_METRICS (METRIC_ID, SPAWN_ID, JOB_ID, TICK_NUMBER, LATENCY, RPS, COUNT) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, status.spawnId, spawnRequest.jobId, status.tenTick, avgLatency, rps, status.tenCount)
        .run();


    await env.DB.prepare(`UPDATE JOB_SPAWNS SET AVG_LATENCY = ?, AVG_RPS = ?, COUNT = ? WHERE SPAWN_ID = ?`)
        .bind(status.avgLatency, status.actualRPS, status.count, status.spawnId)
        .run();

    status.lastD1Update = now;
    status.tenCount = 0;
    status.tenTotalLatency = 0;
    status.tenTick += 1;

    return true;
}

function getR2BatchSize(targetRPS: number, avgLatency: number): number {
    if (!avgLatency || avgLatency <= 0) {
        return 1;
    }

    return Math.min(MAX_PARALLEL_R2_GETS, Math.max(1, Math.ceil((targetRPS * avgLatency) / 1000)));
}

async function getR2Latency(env: Env): Promise<{ ok: boolean, latency: number, error?: unknown }> {
    const startedAt = new Date().getTime();

    try {
        const data = await getRandomR2Bucket(env).get(R2_OBJECT_KEY);
        await data?.body?.cancel();
        return { ok: true, latency: new Date().getTime() - startedAt };
    } catch (error) {
        return { ok: false, latency: new Date().getTime() - startedAt, error };
    }
}

function getRandomR2Bucket(env: Env): R2Bucket {
    const buckets = getR2Buckets(env);
    return buckets[Math.floor(Math.random() * buckets.length)];
}

function getR2Buckets(env: Env): R2Bucket[] {
    return [
        env.R2_00,
        env.R2_01,
        env.R2_02,
        env.R2_03,
        env.R2_04,
        env.R2_05,
        env.R2_06,
        env.R2_07,
        env.R2_08,
        env.R2_09,
        env.R2_10,
        env.R2_11,
        env.R2_12,
        env.R2_13,
        env.R2_14,
        env.R2_15,
        env.R2_16,
        env.R2_17,
        env.R2_18,
        env.R2_19,
        env.R2_20,
        env.R2_21,
        env.R2_22,
        env.R2_23,
        env.R2_24,
    ];
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
