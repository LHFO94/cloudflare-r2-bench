/** Terminal job states — no further work will be scheduled. */
export const TERMINAL_STATUSES = ["COMPLETED", "STOPPED", "FAILED"] as const;
/** States in which a job will still accept or retain agents. */
export const ACTIVE_STATUSES = ["QUEUED", "RUNNING"] as const;

export type JobStartRequest = {
    /** Aggregate requests per second across all agents. */
    targetRPS: number,
    /** Number of load-generator VMs expected to join this job. */
    agents: number,
    /** In-flight requests per agent. Pacing is done by the token bucket; this
     *  only needs to be large enough not to be the limiting factor. */
    workersPerAgent?: number,
    /** Run length in minutes, measured from the synchronised start. */
    duration: number,
    /** Seconds to wait before load begins, giving every agent time to poll in
     *  and warm its connection pool so all VMs start together. */
    startDelaySeconds?: number,
    /** Ignore the rate limiter and run flat out, to find the client ceiling. */
    unthrottled?: boolean,
}

export type JobStartResponse = {
    status: string,
    message: string,
    job_request: JobStartRequest,
    jobId?: string,
}

/** Request body for POST /api/agent/poll. */
export type AgentPollRequest = {
    token: string,
    agentId: string,
    region?: string,
}

/** Response to POST /api/agent/poll. */
export type AgentPollResponse = {
    action: "idle" | "run",
    jobId?: string,
    spawnId?: string,
    targetRPS?: number,
    workers?: number,
    startAtEpochMs?: number,
    stopAtEpochMs?: number,
    unthrottled?: boolean,
    message?: string,
}

export type WatchRequest = {
    jobId: string,
}

export type SpawnMetric = {
    createdAt: string,
    latency: number,
    rps: number,
    errorM1Rate: number,
    workerCount: number,
    p95?: number,
    p99?: number,
    bytes?: number,
}

export type WatchResponse = {
    jobId: string,
    status: string,
    message?: string,
    created_at?: string,
    rps?: number,
    latency?: number,
    runningContainers?: number,
    metrics: SpawnMetric[],
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

/** Identifies an agent callback. Every agent-facing endpoint carries these. */
export type SpawnStatusRequest = {
    token: string,
    spawnId: string,
    jobId: string,
}

export type SpawnMetricsReport = SpawnStatusRequest & {
    tickNumber: number,
    /** Mean latency in ms over the reporting interval. */
    latency: number,
    /** Requests per second over the reporting interval. */
    rps: number,
    /** Errors per second over the reporting interval. */
    errorM1Rate?: number,
    /** Requests completed during the interval. */
    count: number,
    /** Cumulative mean latency in ms for this spawn. */
    avgLatency: number,
    /** Cumulative requests per second for this spawn. */
    actualRPS: number,
    /** Cumulative requests for this spawn. */
    totalCount: number,
    p50?: number,
    p95?: number,
    p99?: number,
    bytes?: number,
    status4xx?: number,
    status5xx?: number,
}

export type SpawnCompletionReport = SpawnStatusRequest & {
    error?: string,
}
