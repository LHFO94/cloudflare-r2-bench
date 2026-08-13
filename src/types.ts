export type JobStartRequest = {
    targetRPS: number,
    concurrency: number,
    concurrentCallsPerSpawn?: number,
    duration: number,
}

export type JobSpawnRequest = {
    type: "spawn",
    jobId: string,
    jobIndex: number,
    targetRPS: number,
    concurrentCallsPerSpawn: number,
    duration: number,
}

export type JobStartResponse = {
    "status": string,
    "message": string,
    "job_request": JobStartRequest,
    "jobId"?: string
}
export type WatchRequest = {
    jobId: string,
}

export type SpawnMetric = {
    createdAt: string,
    latency: number,
    rps: number,
    errorM1Rate: number,
}

export type WatchResponse = {
    jobId: string,
    status: string,
    message?: string,
    created_at?: string,
    rps?: number,
    latency?: number,
    metrics: SpawnMetric[]
}

export type JobSummary = {
    jobId: string,
    status: string,
    rps: number,
    concurrency: number,
    duration: number,
    created_at: string,
    updated_at: string,
}

export type JobsResponse = {
    jobs: JobSummary[],
}

export type SpawnStatus = {
    spawnId: string;
    avgLatency: number;
    duration: number;
    totalLatency: number;
    actualRPS: number;
    count: number;
    startedAt: number,

    tenCount: number;
    tenTotalLatency: number;
    tenTick: number;

    lastStatusCheck: number,
    lastD1Update: number,
}

export type SpawnMetricsReport = {
    token: string,
    spawnId: string,
    jobId: string,
    tickNumber: number,
    latency: number,
    rps: number,
    errorM1Rate?: number,
    count: number,
    avgLatency: number,
    actualRPS: number,
    totalCount: number,
}

export type SpawnStatusRequest = {
    token: string,
    spawnId: string,
    jobId: string,
}

export type SpawnCompletionReport = SpawnStatusRequest & {
    error?: string,
}
