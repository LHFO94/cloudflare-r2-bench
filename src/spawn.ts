import { stat } from "node:fs";
import { JobSpawnContinue, JobSpawnRequest, SpawnStatus } from "./types";

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

        const startFetching = new Date().getTime();

        try {
            const data = await env.R2.get('/bench.tar')
        } catch (err) {
            console.error(`Failed fetching R2 data, error: ${err}`);
        }
        const now = new Date().getTime();
        const latency = now - startFetching;

        spawnStatus.count += 1;
        spawnStatus.tenCount += 1;
        spawnStatus.duration = now - spawnStatus.startedAt;
        spawnStatus.totalLatency += latency;
        spawnStatus.tenTotalLatency += latency;
        spawnStatus.actualRPS = spawnStatus.duration < 1000 ? spawnStatus.count : (spawnStatus.count / (spawnStatus.duration / 1000))
        spawnStatus.avgLatency = spawnStatus.totalLatency / spawnStatus.count;

        if (await maybeUpdateD1(spawnStatus, spawnRequest, env)) {
            const continueMessage: JobSpawnContinue = {
                type: "spawn_continue",
                request: spawnRequest,
                status: spawnStatus,
            }
            await env.r2bench_spawns.send(continueMessage);
            break;
        }

        const estimatedSleep = Math.min(Math.floor(((spawnRequest.targetRPS + 1) / spawnStatus.avgLatency) - 1));
        if (estimatedSleep <= 0) {
            console.warn(`R2 latency too hight (${Math.ceil(spawnStatus.avgLatency)}ms), can't match target RPS (${spawnRequest.targetRPS})`)
        } else {
            await sleep(estimatedSleep);
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
