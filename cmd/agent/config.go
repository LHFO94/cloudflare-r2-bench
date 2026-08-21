package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/LHFO94/cloudflare-r2-bench/internal/env"
	"github.com/LHFO94/cloudflare-r2-bench/internal/r2"
)

// Config is read entirely from the environment. On GCE the startup script
// writes /etc/r2agent/agent.env, which systemd loads as an EnvironmentFile.
// Keeping the agent env-only makes it runnable locally with the same variables.
//
// The R2_* names are shared with cmd/seeder so that both address the same
// buckets and key layout from one exported set of variables.
type Config struct {
	// R2 / S3 target. Credentials come from Terraform via instance metadata,
	// never through the control plane.
	Endpoint     string
	AccessKey    string
	SecretKey    string
	Region       string
	BucketPrefix string
	BucketCount  int
	KeyPrefix    string
	Keyspace     int

	// Control plane.
	ControlPlaneURL string
	AgentToken      string
	AgentID         string
	AgentRegion     string

	// Cloudflare Access service token, for deployments where the control
	// plane sits behind Access. Optional: both empty means no Access, which
	// is the case for `wrangler dev` and for unprotected workers.dev routes.
	// Distinct from AgentToken, which the Worker checks itself - Access
	// rejects the request at the edge before the Worker ever runs.
	AccessClientID     string
	AccessClientSecret string

	// Tuning.
	MaxWorkers      int
	MaxIdlePerHost  int
	PollInterval    time.Duration
	MetricsInterval time.Duration
	RequestTimeout  time.Duration
}

func LoadConfig() (*Config, error) {
	c := &Config{
		Endpoint:        os.Getenv("R2_ENDPOINT"),
		AccessKey:       os.Getenv("R2_ACCESS_KEY_ID"),
		SecretKey:       os.Getenv("R2_SECRET_ACCESS_KEY"),
		Region:          env.String("R2_REGION", "auto"),
		BucketPrefix:    env.String("R2_BUCKET_PREFIX", "r2bench-"),
		BucketCount:     env.Int("R2_BUCKET_COUNT", 25),
		KeyPrefix:       env.String("R2_KEY_PREFIX", "obj/"),
		Keyspace:        env.Int("R2_KEYSPACE", 40000),
		ControlPlaneURL: strings.TrimRight(os.Getenv("CONTROL_PLANE_URL"), "/"),
		AgentToken:      os.Getenv("AGENT_TOKEN"),
		AgentID:         env.String("AGENT_ID", defaultAgentID()),
		AgentRegion:     env.String("AGENT_REGION", "unknown"),

		AccessClientID:     os.Getenv("CF_ACCESS_CLIENT_ID"),
		AccessClientSecret: os.Getenv("CF_ACCESS_CLIENT_SECRET"),
		MaxWorkers:         env.Int("MAX_WORKERS", 2048),
		MaxIdlePerHost:     env.Int("MAX_IDLE_CONNS_PER_HOST", 4096),
		PollInterval:       time.Duration(env.Int("POLL_INTERVAL_SECONDS", 5)) * time.Second,
		MetricsInterval:    time.Duration(env.Int("METRICS_INTERVAL_SECONDS", 10)) * time.Second,
		RequestTimeout:     time.Duration(env.Int("REQUEST_TIMEOUT_SECONDS", 30)) * time.Second,
	}

	var missing []string
	for name, v := range map[string]string{
		"R2_ENDPOINT":          c.Endpoint,
		"R2_ACCESS_KEY_ID":     c.AccessKey,
		"R2_SECRET_ACCESS_KEY": c.SecretKey,
		"CONTROL_PLANE_URL":    c.ControlPlaneURL,
		"AGENT_TOKEN":          c.AgentToken,
	} {
		if v == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing required environment variables: %s", strings.Join(missing, ", "))
	}
	if c.BucketCount <= 0 {
		return nil, fmt.Errorf("R2_BUCKET_COUNT must be > 0, got %d", c.BucketCount)
	}
	if c.Keyspace <= 0 {
		return nil, fmt.Errorf("R2_KEYSPACE must be > 0, got %d", c.Keyspace)
	}
	// Half a service token authenticates nothing: Access ignores a lone header
	// and answers with a login redirect, which looks identical to having
	// configured no token at all. Fail at startup instead, where the cause is
	// legible, rather than after the fleet is up.
	if (c.AccessClientID == "") != (c.AccessClientSecret == "") {
		return nil, fmt.Errorf("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together, or both left empty")
	}
	return c, nil
}

// Naming returns the shared bucket/key layout, which must match the seeder and
// the Terraform r2 module.
func (c *Config) Naming() r2.Naming {
	return r2.Naming{
		BucketPrefix: c.BucketPrefix,
		BucketCount:  c.BucketCount,
		KeyPrefix:    c.KeyPrefix,
		Keyspace:     c.Keyspace,
	}
}

func defaultAgentID() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "agent-" + strconv.FormatInt(time.Now().UnixNano(), 36)
}
