-- Move the schema from Cloudflare-Container spawns to externally hosted,
-- self-registering VM agents.
--
-- Every statement is additive so the migration can be applied to an existing
-- database that still holds results from the container-based harness.

-- ---------------------------------------------------------------------------
-- JOBS
-- ---------------------------------------------------------------------------
-- CONCURRENCY previously meant "number of containers". AGENTS is the explicit
-- replacement (number of load-generator VMs); CONCURRENCY is kept and written
-- with the same value so historical rows and any old queries still resolve.
ALTER TABLE JOBS ADD COLUMN AGENTS NUMBER DEFAULT 0;
ALTER TABLE JOBS ADD COLUMN WORKERS_PER_AGENT NUMBER DEFAULT 0;

-- Absolute epoch-millisecond window. The control plane no longer counts ticks
-- to decide when a run ends, so agents and the reaper can agree on the
-- schedule without a shared clock authority beyond NTP.
ALTER TABLE JOBS ADD COLUMN START_AT INTEGER DEFAULT 0;
ALTER TABLE JOBS ADD COLUMN STOP_AT INTEGER DEFAULT 0;

-- 1 = ignore targetRPS and drive as fast as the workers allow, for finding the
-- ceiling rather than holding a fixed rate.
ALTER TABLE JOBS ADD COLUMN UNTHROTTLED INTEGER DEFAULT 0;

UPDATE JOBS SET AGENTS = CONCURRENCY WHERE AGENTS = 0;

-- ---------------------------------------------------------------------------
-- JOB_SPAWNS
-- ---------------------------------------------------------------------------
-- AGENT_ID is the stable VM identity (instance name); SPAWN_ID is
-- "<jobId>-<agentId>" so a restarted agent reclaims its own slot instead of
-- consuming a second one.
ALTER TABLE JOB_SPAWNS ADD COLUMN AGENT_ID TEXT;
ALTER TABLE JOB_SPAWNS ADD COLUMN REGION TEXT;

-- Position within the job, used to deterministically shard the target RPS.
ALTER TABLE JOB_SPAWNS ADD COLUMN SLOT INTEGER;

-- Epoch ms of the last poll or metrics report. The reaper fails spawns that
-- stop reporting, which is the only way a preempted VM gets noticed.
ALTER TABLE JOB_SPAWNS ADD COLUMN LAST_SEEN INTEGER;

-- ---------------------------------------------------------------------------
-- JOB_SPAWN_METRICS
-- ---------------------------------------------------------------------------
-- Percentiles come from the agent's local histogram: averaging averages across
-- eight VMs would hide exactly the tail this test exists to measure.
ALTER TABLE JOB_SPAWN_METRICS ADD COLUMN P50 NUMBER DEFAULT 0;
ALTER TABLE JOB_SPAWN_METRICS ADD COLUMN P95 NUMBER DEFAULT 0;
ALTER TABLE JOB_SPAWN_METRICS ADD COLUMN P99 NUMBER DEFAULT 0;

-- Response bytes in the interval, so achieved throughput can be checked
-- against the 21.6 Gbps per-VM ingress ceiling.
ALTER TABLE JOB_SPAWN_METRICS ADD COLUMN BYTES INTEGER DEFAULT 0;

-- Split by class: 4xx usually means a seeding or signing bug on our side,
-- 5xx means R2 shed the request. Conflating them wastes a run.
ALTER TABLE JOB_SPAWN_METRICS ADD COLUMN STATUS_4XX INTEGER DEFAULT 0;
ALTER TABLE JOB_SPAWN_METRICS ADD COLUMN STATUS_5XX INTEGER DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- The agent poll path runs on every agent every few seconds and the watch page
-- aggregates the metrics table on a timer; both were full scans before.
CREATE INDEX IF NOT EXISTS IDX_JOBS_STATUS ON JOBS(STATUS);
CREATE INDEX IF NOT EXISTS IDX_JOB_SPAWNS_JOB ON JOB_SPAWNS(JOB_ID, STATUS);
CREATE INDEX IF NOT EXISTS IDX_JOB_SPAWNS_LAST_SEEN ON JOB_SPAWNS(STATUS, LAST_SEEN);
CREATE INDEX IF NOT EXISTS IDX_JOB_SPAWN_METRICS_JOB ON JOB_SPAWN_METRICS(JOB_ID, CREATED_AT);

-- Hard guarantee that two agents cannot occupy the same slot and therefore
-- cannot be handed the same share of the target RPS. NULLs from pre-migration
-- rows are exempt, as SQLite treats each NULL as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS IDX_JOB_SPAWNS_SLOT ON JOB_SPAWNS(JOB_ID, SLOT);
