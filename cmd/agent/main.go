// Command agent is the R2 benchmark load generator.
//
// It runs on external VMs, polls the Cloudflare Worker control plane for an
// assignment, drives S3 GET traffic against a set of R2 buckets, and pushes
// metrics back to the control plane. Credentials for R2 come from the local
// environment (populated from instance metadata by Terraform), never from the
// control plane.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("[r2agent] ")

	cfg, err := LoadConfig()
	if err != nil {
		log.Fatalf("configuration error: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	runner := NewRunner(cfg)
	control := NewControlClient(cfg)

	log.Printf("agent %s starting in %s: endpoint=%s buckets=%d keyspace=%d",
		cfg.AgentID, cfg.AgentRegion, cfg.Endpoint, cfg.BucketCount, cfg.Keyspace)

	for ctx.Err() == nil {
		resp, err := control.Poll(ctx)
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			log.Printf("poll failed: %v", err)
			sleepCtx(ctx, cfg.PollInterval)
			continue
		}

		if resp.Action != "run" {
			sleepCtx(ctx, cfg.PollInterval)
			continue
		}

		if err := execute(ctx, cfg, runner, control, resp); err != nil {
			log.Printf("assignment %s failed: %v", resp.SpawnID, err)
		}
	}

	log.Printf("agent %s shutting down", cfg.AgentID)
}

func execute(ctx context.Context, cfg *Config, runner *Runner, control *ControlClient, resp *PollResponse) error {
	stopAt := time.UnixMilli(resp.StopAtEpochMs)
	if !stopAt.After(time.Now()) {
		log.Printf("assignment %s already expired, reporting completion", resp.SpawnID)
		return control.ReportComplete(detached(), resp.JobID, resp.SpawnID, "")
	}

	assignment := Assignment{
		JobID:       resp.JobID,
		SpawnID:     resp.SpawnID,
		TargetRPS:   resp.TargetRPS,
		Workers:     resp.Workers,
		StopAt:      stopAt,
		Unthrottled: resp.Unthrottled,
	}

	log.Printf("assignment %s: targetRPS=%d workers=%d unthrottled=%t duration=%s",
		assignment.SpawnID, assignment.TargetRPS, assignment.Workers,
		assignment.Unthrottled, time.Until(stopAt).Round(time.Second))

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Warm up inside the start delay so that TLS handshakes and connection
	// setup are not counted as latency, and are not competing for CPU once
	// load begins.
	warmup := assignment.Workers
	if warmup > 512 {
		warmup = 512
	}
	if warmup > 0 {
		warmStart := time.Now()
		runner.Warmup(runCtx, warmup)
		log.Printf("warmed %d connections in %s", warmup, time.Since(warmStart).Round(time.Millisecond))
	}

	// Hold until the shared start instant. Every agent on the job is given the
	// same value, so the fleet begins together rather than staggered by up to
	// one poll interval; a late-joining agent skips the wait.
	if startAt := time.UnixMilli(resp.StartAtEpochMs); startAt.After(time.Now()) {
		log.Printf("holding %s until synchronised start", time.Until(startAt).Round(time.Millisecond))
		sleepCtx(runCtx, time.Until(startAt))
		if runCtx.Err() != nil {
			return control.ReportComplete(detached(), assignment.JobID, assignment.SpawnID, "")
		}
	}

	metrics := NewMetrics()
	start := time.Now()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		reportLoop(runCtx, control, assignment, metrics, cfg.MetricsInterval, start)
	}()
	go func() {
		defer wg.Done()
		watchStatus(runCtx, cancel, control, assignment)
	}()

	runner.Run(runCtx, assignment, metrics)
	cancel()
	wg.Wait()

	// Final flush on a detached context: runCtx is cancelled by now.
	final := metrics.Snapshot()
	elapsed := time.Since(start).Seconds()
	log.Printf("assignment %s finished: %d requests, %d errors, %.0f RPS, mean %.1fms, p99 %.1fms, %.2f GB",
		assignment.SpawnID, final.Count, final.Errors, ratePerSecond(final.Count, elapsed),
		final.MeanLatencyMillis(), final.Quantile(0.99), float64(final.Bytes)/1e9)

	flushCtx, flushCancel := context.WithTimeout(detached(), 20*time.Second)
	defer flushCancel()

	report := buildReport(assignment, final, final, elapsed, elapsed, -1)
	if err := control.ReportMetrics(flushCtx, report); err != nil {
		log.Printf("final metrics flush failed: %v", err)
	}
	return control.ReportComplete(flushCtx, assignment.JobID, assignment.SpawnID, "")
}

// reportLoop pushes an interval metrics report to the control plane on a timer.
func reportLoop(ctx context.Context, control *ControlClient, a Assignment, m *Metrics, interval time.Duration, start time.Time) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var prev Snapshot
	prevAt := start
	tick := 0

	for {
		var now time.Time
		select {
		case <-ctx.Done():
			return
		case now = <-ticker.C:
		}

		cur := m.Snapshot()
		delta := cur.Sub(prev)
		intervalSecs := now.Sub(prevAt).Seconds()
		totalSecs := now.Sub(start).Seconds()

		report := buildReport(a, cur, delta, totalSecs, intervalSecs, tick)
		if err := control.ReportMetrics(ctx, report); err != nil {
			if ctx.Err() == nil {
				log.Printf("metrics report tick %d failed: %v", tick, err)
			}
		} else {
			log.Printf("tick %d: %.0f RPS, mean %.1fms, p95 %.1fms, p99 %.1fms, errors %d",
				tick, report.RPS, report.Latency, report.P95, report.P99, delta.Errors)
		}

		prev = cur
		prevAt = now
		tick++
	}
}

func buildReport(a Assignment, cumulative, delta Snapshot, totalSecs, intervalSecs float64, tick int) MetricsReport {
	return MetricsReport{
		SpawnID:     a.SpawnID,
		JobID:       a.JobID,
		TickNumber:  tick,
		Latency:     delta.MeanLatencyMillis(),
		RPS:         ratePerSecond(delta.Count, intervalSecs),
		ErrorM1Rate: ratePerSecond(delta.Errors, intervalSecs),
		Count:       delta.Count,
		AvgLatency:  cumulative.MeanLatencyMillis(),
		ActualRPS:   ratePerSecond(cumulative.Count, totalSecs),
		TotalCount:  cumulative.Count,
		P50:         delta.Quantile(0.50),
		P95:         delta.Quantile(0.95),
		P99:         delta.Quantile(0.99),
		Bytes:       delta.Bytes,
		Status4xx:   delta.Status4x,
		Status5xx:   delta.Status5x,
	}
}

// watchStatus cancels the run if an operator stops the job from the UI.
func watchStatus(ctx context.Context, cancel context.CancelFunc, control *ControlClient, a Assignment) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		status, err := control.JobStatus(ctx, a.JobID, a.SpawnID)
		if err != nil {
			continue // transient; the stop deadline still bounds the run
		}
		switch status {
		case "STOPPING", "STOPPED", "FAILED", "COMPLETED":
			log.Printf("job %s entered %s, stopping load", a.JobID, status)
			cancel()
			return
		}
	}
}

func ratePerSecond(n uint64, seconds float64) float64 {
	if seconds <= 0 {
		return 0
	}
	return float64(n) / seconds
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// detached returns a context that survives cancellation of the run context,
// so that terminal reports still reach the control plane.
func detached() context.Context { return context.WithoutCancel(context.Background()) }
