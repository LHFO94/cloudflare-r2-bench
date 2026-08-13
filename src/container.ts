import { DurableObject } from "cloudflare:workers";
import { JobSpawnRequest } from "./types";
import { complete_benchmark_spawn, record_benchmark_metrics } from "./spawn";

const METRICS_PORT = 8080;
const INITIAL_METRICS_POLL_SECONDS = 5;
const METRICS_POLL_INTERVAL_SECONDS = 10;
const REQUEST_STORAGE_KEY = "request";
const TOKEN_STORAGE_KEY = "token";
const LAST_TOTAL_COUNT_STORAGE_KEY = "lastTotalCount";
const TICK_NUMBER_STORAGE_KEY = "tickNumber";
const COMPLETED_STORAGE_KEY = "completed";

export type ContainerRuntimeEnv = Env & {
    R2_ACCOUNT_ID?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
}

export type ParsedContainerMetrics = {
    totalCount: number;
    latency: number;
    meanRate: number;
    errorM1Rate: number;
}

export type BenchmarkIterationResult = {
    continue: boolean;
    delaySeconds?: number;
    nextSpawnIndex?: number;
    startRetryCounts?: Record<string, number>;
}


export class BenchmarkContainer extends DurableObject<Env> {
    async startBenchmark(spawnRequest: JobSpawnRequest): Promise<void> {
        const spawnId = getSpawnId(spawnRequest);
        const token = crypto.randomUUID();
        const env = this.env as ContainerRuntimeEnv;
        const startedAt = Date.now();
        const stopAt = getBenchmarkStopAt(spawnRequest);
        const remainingDurationMinutes = Math.max(1, Math.ceil((stopAt - startedAt) / 60_000));

        if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
            throw new Error("Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY for container R2 access");
        }

        await this.ctx.storage.put({
            [REQUEST_STORAGE_KEY]: spawnRequest,
            [TOKEN_STORAGE_KEY]: token,
            [LAST_TOTAL_COUNT_STORAGE_KEY]: 0,
            [TICK_NUMBER_STORAGE_KEY]: 0,
            [COMPLETED_STORAGE_KEY]: false,
        });
        await this.ctx.storage.deleteAlarm();

        if (!this.ctx.container) {
            throw new Error("BenchmarkContainer is not configured with a container binding");
        }

        if (!this.ctx.container.running) {
            this.ctx.container.start({
                enableInternet: true,
                env: {
                    CONCURRENCY: String(Math.floor(spawnRequest.concurrentCallsPerSpawn)),
                    TARGET_RPS: String(Math.floor(spawnRequest.targetRPS)),
                    DURATION: String(remainingDurationMinutes),
                    STOP_AT_EPOCH_MS: String(stopAt),
                    METRICS_PORT: String(METRICS_PORT),
                    S3_CLIENT_ID: env.R2_ACCESS_KEY_ID,
                    S3_CLIENT_SECRET: env.R2_SECRET_ACCESS_KEY,
                    S3_URI: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
                },
                labels: {
                    jobId: spawnRequest.jobId,
                    spawnId,
                },
            });
        }

        await this.env.DB.prepare(`UPDATE JOBS SET STATUS = 'RUNNING' WHERE JOB_ID = ? AND STATUS = 'QUEUED'`)
            .bind(spawnRequest.jobId)
            .run();

        await this.env.DB.prepare(`INSERT INTO JOB_SPAWNS (SPAWN_ID, JOB_ID, STATUS) VALUES (?, ?, 'RUNNING')
        ON CONFLICT (SPAWN_ID) DO UPDATE SET STATUS = 'RUNNING', CREATED_AT = EXCLUDED.CREATED_AT`)
            .bind(spawnId, spawnRequest.jobId)
            .run();
    }

    async stopBenchmark(): Promise<void> {
        await this.finishBenchmark();
    }

    async validateToken(token: string): Promise<boolean> {
        return token === await this.ctx.storage.get<string>(TOKEN_STORAGE_KEY);
    }

    async runBenchmarkIteration(spawnRequest: JobSpawnRequest): Promise<BenchmarkIterationResult> {
        const storedSpawnRequest = await this.ctx.storage.get<JobSpawnRequest>(REQUEST_STORAGE_KEY);
        if (!storedSpawnRequest) {
            await this.startBenchmark(spawnRequest);
            return { continue: true, delaySeconds: INITIAL_METRICS_POLL_SECONDS };
        }

        if (await this.ctx.storage.get<boolean>(COMPLETED_STORAGE_KEY)) {
            return { continue: false };
        }

        const jobStatus = await this.getJobStatus(storedSpawnRequest.jobId);
        if (['STOPPING', 'STOPPED'].includes(jobStatus)) {
            await this.stopBenchmark();
            return { continue: false };
        }
        if (['FAILED', 'COMPLETED'].includes(jobStatus)) {
            await this.finishBenchmark(jobStatus === 'FAILED' ? 'Job failed' : undefined);
            return { continue: false };
        }

        const stopAt = getBenchmarkStopAt(storedSpawnRequest);
        const now = Date.now();

        if (this.ctx.container?.running) {
            try {
                await this.recordMetricsFromContainer(storedSpawnRequest);
            } catch (error) {
                console.warn(`Failed to fetch benchmark metrics for ${getSpawnId(storedSpawnRequest)}: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else if (now < stopAt) {
            console.warn(`Benchmark container ${getSpawnId(storedSpawnRequest)} is not running before the job duration elapsed`);
        }

        if (now >= stopAt) {
            await this.finishBenchmark();
            return { continue: false };
        }

        return { continue: true, delaySeconds: METRICS_POLL_INTERVAL_SECONDS };
    }

    async runStoredBenchmarkIteration(): Promise<BenchmarkIterationResult> {
        const spawnRequest = await this.ctx.storage.get<JobSpawnRequest>(REQUEST_STORAGE_KEY);
        if (!spawnRequest) {
            return { continue: false };
        }

        return await this.runBenchmarkIteration(spawnRequest);
    }

    private async recordMetricsFromContainer(spawnRequest: JobSpawnRequest): Promise<void> {
        if (!this.ctx.container) {
            throw new Error("BenchmarkContainer is not configured with a container binding");
        }

        const response = await this.ctx.container.getTcpPort(METRICS_PORT).fetch("http://container/metrics");
        if (!response.ok) {
            throw new Error(`Metrics endpoint returned ${response.status}`);
        }

        const metrics = parseContainerMetrics(await response.json());
        if (!metrics) {
            throw new Error("Metrics endpoint returned an unsupported payload");
        }

        const lastTotalCount = await this.ctx.storage.get<number>(LAST_TOTAL_COUNT_STORAGE_KEY) ?? 0;
        const tickNumber = await this.ctx.storage.get<number>(TICK_NUMBER_STORAGE_KEY) ?? 0;
        const intervalCount = Math.max(0, metrics.totalCount - lastTotalCount);

        await record_benchmark_metrics(this.env, {
            token: await this.ctx.storage.get<string>(TOKEN_STORAGE_KEY) ?? "",
            spawnId: getSpawnId(spawnRequest),
            jobId: spawnRequest.jobId,
            tickNumber,
            latency: metrics.latency,
            rps: metrics.meanRate,
            errorM1Rate: metrics.errorM1Rate,
            count: intervalCount,
            avgLatency: metrics.latency,
            actualRPS: metrics.meanRate,
            totalCount: metrics.totalCount,
        });

        await this.ctx.storage.put({
            [LAST_TOTAL_COUNT_STORAGE_KEY]: metrics.totalCount,
            [TICK_NUMBER_STORAGE_KEY]: tickNumber + 1,
        });
    }

    private async finishBenchmark(error?: string): Promise<void> {
        if (await this.ctx.storage.get<boolean>(COMPLETED_STORAGE_KEY)) {
            return;
        }

        const spawnRequest = await this.ctx.storage.get<JobSpawnRequest>(REQUEST_STORAGE_KEY);
        if (!spawnRequest) {
            return;
        }

        await complete_benchmark_spawn(this.env, {
            token: await this.ctx.storage.get<string>(TOKEN_STORAGE_KEY) ?? "",
            spawnId: getSpawnId(spawnRequest),
            jobId: spawnRequest.jobId,
            error,
        });

        if (this.ctx.container?.running) {
            await this.ctx.container.destroy();
        }

        await this.ctx.storage.put(COMPLETED_STORAGE_KEY, true);
        await this.ctx.storage.deleteAlarm();
    }

    private async getJobStatus(jobId: string): Promise<string> {
        const job = await this.env.DB.prepare(`SELECT STATUS FROM JOBS WHERE JOB_ID = ?`)
            .bind(jobId)
            .first();

        return job?.['STATUS'] as string | undefined ?? "unknown";
    }
}

export function getSpawnId(spawnRequest: JobSpawnRequest): string {
    return `${spawnRequest.jobId}-${spawnRequest.jobIndex}`;
}

export function getBenchmarkStopAt(spawnRequest: JobSpawnRequest): number {
    return spawnRequest.jobStartedAt + spawnRequest.duration * 60 * 1000;
}

export function parseContainerMetrics(value: unknown): ParsedContainerMetrics | undefined {
    const metrics = getRecord(value);
    const timer = getRecord(getRecord(metrics?.timers)?.countTimer);
    const errorTimer = getRecord(getRecord(metrics?.timers)?.error);
    if (!timer) {
        return undefined;
    }

    const totalCount = getFiniteNumber(timer.count);
    const meanRate = getFiniteNumber(timer.m1_rate);
    const errorM1Rate = getFiniteNumber(errorTimer?.m1_rate) ?? 0;
    const histogramLatency = getFiniteNumber(getRecord(getRecord(metrics?.histograms)?.latency)?.mean);
    const latency = histogramLatency;

    if (totalCount === undefined || meanRate === undefined || latency === undefined) {
        return undefined;
    }

    return { totalCount, meanRate, latency, errorM1Rate };
}

export function getRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function getFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
