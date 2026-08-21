package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ControlClient talks to the Cloudflare Worker control plane.
type ControlClient struct {
	baseURL string
	token   string
	agentID string
	region  string
	http    *http.Client
}

func NewControlClient(cfg *Config) *ControlClient {
	return &ControlClient{
		baseURL: cfg.ControlPlaneURL,
		token:   cfg.AgentToken,
		agentID: cfg.AgentID,
		region:  cfg.AgentRegion,
		http: &http.Client{
			Timeout: 15 * time.Second,
			// Never follow redirects. The control plane only ever answers with
			// JSON, so a 3xx means something in front of it is intercepting -
			// an identity proxy such as Cloudflare Access, or a captive portal.
			// Following the redirect fetches a login page and fails later with
			// "invalid character '<'", which hides the real cause; surfacing
			// the 302 and its Location names the problem outright.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
			Transport: &http.Transport{
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     60 * time.Second,
			},
		},
	}
}

type pollRequest struct {
	Token   string `json:"token"`
	AgentID string `json:"agentId"`
	Region  string `json:"region"`
}

// PollResponse is the control plane's answer to a poll. Action is "idle" when
// there is no work, or "run" with a populated assignment.
type PollResponse struct {
	Action  string `json:"action"`
	JobID   string `json:"jobId"`
	SpawnID string `json:"spawnId"`
	// TargetRPS is this agent's share of the job total, not the job total.
	TargetRPS int `json:"targetRPS"`
	Workers   int `json:"workers"`
	// StartAtEpochMs is a wall-clock instant shared by every agent on the job.
	// Agents warm up before it and begin load exactly on it, so the fleet
	// reaches the aggregate target together instead of ramping in stages.
	StartAtEpochMs int64  `json:"startAtEpochMs"`
	StopAtEpochMs  int64  `json:"stopAtEpochMs"`
	Unthrottled    bool   `json:"unthrottled"`
	Message        string `json:"message"`
}

func (c *ControlClient) Poll(ctx context.Context) (*PollResponse, error) {
	var out PollResponse
	err := c.post(ctx, "/api/agent/poll", pollRequest{
		Token:   c.token,
		AgentID: c.agentID,
		Region:  c.region,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// MetricsReport matches the SpawnMetricsReport type in the Worker.
type MetricsReport struct {
	Token       string  `json:"token"`
	SpawnID     string  `json:"spawnId"`
	JobID       string  `json:"jobId"`
	TickNumber  int     `json:"tickNumber"`
	Latency     float64 `json:"latency"`
	RPS         float64 `json:"rps"`
	ErrorM1Rate float64 `json:"errorM1Rate"`
	Count       uint64  `json:"count"`
	AvgLatency  float64 `json:"avgLatency"`
	ActualRPS   float64 `json:"actualRPS"`
	TotalCount  uint64  `json:"totalCount"`
	P50         float64 `json:"p50"`
	P95         float64 `json:"p95"`
	P99         float64 `json:"p99"`
	Bytes       uint64  `json:"bytes"`
	Status4xx   uint64  `json:"status4xx"`
	Status5xx   uint64  `json:"status5xx"`
}

func (c *ControlClient) ReportMetrics(ctx context.Context, r MetricsReport) error {
	r.Token = c.token
	return c.post(ctx, "/api/internal/spawn-metrics", r, nil)
}

type statusRequest struct {
	Token   string `json:"token"`
	SpawnID string `json:"spawnId"`
	JobID   string `json:"jobId"`
}

type statusResponse struct {
	Status string `json:"status"`
}

// JobStatus returns the control plane's view of the job, used by the agent to
// notice an operator-initiated stop.
func (c *ControlClient) JobStatus(ctx context.Context, jobID, spawnID string) (string, error) {
	var out statusResponse
	err := c.post(ctx, "/api/internal/spawn-status", statusRequest{
		Token:   c.token,
		SpawnID: spawnID,
		JobID:   jobID,
	}, &out)
	if err != nil {
		return "", err
	}
	return out.Status, nil
}

type completionRequest struct {
	Token   string `json:"token"`
	SpawnID string `json:"spawnId"`
	JobID   string `json:"jobId"`
	Error   string `json:"error,omitempty"`
}

func (c *ControlClient) ReportComplete(ctx context.Context, jobID, spawnID, errMsg string) error {
	return c.post(ctx, "/api/internal/spawn-complete", completionRequest{
		Token:   c.token,
		SpawnID: spawnID,
		JobID:   jobID,
		Error:   errMsg,
	}, nil)
}

func (c *ControlClient) post(ctx context.Context, path string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		// Name the interception explicitly: the Location host is the single most
		// useful piece of information for whoever has to unblock the fleet.
		return fmt.Errorf("%s returned %d redirecting to %q - the control plane is behind an identity proxy that the agent cannot authenticate to; exempt this hostname or give the agent service-token credentials",
			path, resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s returned %d: %s", path, resp.StatusCode, truncate(string(data), 200))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
