package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"github.com/LHFO94/cloudflare-r2-bench/internal/r2"
	"io"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"sync"
	"time"
)

// newTransport builds an HTTP client tuned for high request rates against a
// single S3 host.
//
// HTTP/2 is deliberately disabled. Go's default transport multiplexes all
// requests to a host over a single TCP connection under h2, and GCP caps each
// unique 5-tuple flow at 3 Gbps. Forcing HTTP/1.1 spreads load across a large
// connection pool and keeps per-flow throughput well under that ceiling.
func newTransport(cfg *Config) *http.Transport {
	return &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     false,
		TLSClientConfig:       &tls.Config{NextProtos: []string{"http/1.1"}},
		MaxIdleConns:          0, // unlimited
		MaxIdleConnsPerHost:   cfg.MaxIdlePerHost,
		MaxConnsPerHost:       0, // unlimited
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 0,
		DisableCompression:    true, // payloads are opaque bytes
		WriteBufferSize:       32 * 1024,
		ReadBufferSize:        64 * 1024,
	}
}

// Assignment is the per-run configuration handed down by the control plane.
type Assignment struct {
	JobID       string
	SpawnID     string
	TargetRPS   int
	Workers     int
	StopAt      time.Time
	Unthrottled bool
}

type Runner struct {
	cfg    *Config
	client *http.Client
	signer *r2.Signer
	naming r2.Naming
}

func NewRunner(cfg *Config) *Runner {
	return &Runner{
		cfg: cfg,
		client: &http.Client{
			Transport: newTransport(cfg),
			Timeout:   cfg.RequestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		signer: r2.NewSigner(cfg.AccessKey, cfg.SecretKey, cfg.Region),
		naming: cfg.Naming(),
	}
}

// Warmup establishes TLS connections before the timed run so that the ramp is
// not dominated by handshakes. Failures are logged and ignored; the run itself
// will surface any real connectivity problem.
func (r *Runner) Warmup(ctx context.Context, conns int) {
	if conns <= 0 {
		return
	}
	var wg sync.WaitGroup
	wg.Add(conns)
	for i := 0; i < conns; i++ {
		go func(i int) {
			defer wg.Done()
			if _, err := r.fetch(ctx, i%r.cfg.BucketCount, i%r.cfg.Keyspace); err != nil {
				if ctx.Err() == nil && i == 0 {
					log.Printf("warmup request failed: %v", err)
				}
			}
		}(i)
	}
	wg.Wait()
}

// Run drives load until the assignment's stop time or ctx cancellation.
// Observations are recorded into m, which the caller owns so that each run
// reports against a fresh set of counters.
func (r *Runner) Run(ctx context.Context, a Assignment, m *Metrics) {
	runCtx, cancel := context.WithDeadline(ctx, a.StopAt)
	defer cancel()

	workers := a.Workers
	if workers <= 0 || workers > r.cfg.MaxWorkers {
		workers = r.cfg.MaxWorkers
	}

	var tokens <-chan struct{}
	if !a.Unthrottled && a.TargetRPS > 0 {
		tokens = startPacer(runCtx, a.TargetRPS)
	}

	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			r.worker(runCtx, tokens, m)
		}()
	}
	wg.Wait()
}

func (r *Runner) worker(ctx context.Context, tokens <-chan struct{}, m *Metrics) {
	for {
		if tokens != nil {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-tokens:
				if !ok {
					return
				}
			}
		} else {
			select {
			case <-ctx.Done():
				return
			default:
			}
		}

		bucket := rand.IntN(r.cfg.BucketCount)
		key := rand.IntN(r.cfg.Keyspace)

		start := time.Now()
		n, err := r.fetch(ctx, bucket, key)
		elapsed := uint64(time.Since(start).Microseconds())

		if err != nil {
			if ctx.Err() != nil {
				return // shutting down; not a real error
			}
			m.ObserveError(elapsed, isTimeout(err))
			continue
		}
		m.ObserveSuccess(elapsed, n.bytes, n.status)
	}
}

type fetchResult struct {
	bytes  int64
	status int
}

func (r *Runner) fetch(ctx context.Context, bucketIdx, keyIdx int) (fetchResult, error) {
	url := fmt.Sprintf("%s/%s/%s", r.cfg.Endpoint, r.naming.BucketName(bucketIdx), r.naming.ObjectKey(keyIdx))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fetchResult{}, err
	}
	r.signer.Sign(req, r2.EmptyPayloadSHA256, time.Now())

	resp, err := r.client.Do(req)
	if err != nil {
		return fetchResult{}, err
	}
	defer resp.Body.Close()

	// Drain in bulk. Reading byte-by-byte here would make the client, not R2,
	// the bottleneck.
	n, err := io.Copy(io.Discard, resp.Body)
	if err != nil {
		return fetchResult{bytes: n, status: resp.StatusCode}, err
	}
	return fetchResult{bytes: n, status: resp.StatusCode}, nil
}

// startPacer implements open-loop rate limiting: tokens are emitted at a fixed
// wall-clock rate regardless of how long requests take. A closed-loop pacer
// (sleep between requests, as the original Java harness used) silently reduces
// offered load when the target slows down, which hides the very saturation the
// benchmark exists to find.
func startPacer(ctx context.Context, rps int) <-chan struct{} {
	const tickInterval = 5 * time.Millisecond
	ticksPerSecond := float64(time.Second) / float64(tickInterval)
	perTick := float64(rps) / ticksPerSecond

	// Cap burst at ~20ms of tokens so a stalled consumer cannot bank a
	// large backlog and then release it all at once.
	capacity := int(perTick * 4)
	if capacity < 1 {
		capacity = 1
	}

	ch := make(chan struct{}, capacity)
	go func() {
		defer close(ch)
		ticker := time.NewTicker(tickInterval)
		defer ticker.Stop()

		var credit float64
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}

			credit += perTick
			emit := int(credit)
			credit -= float64(emit)

			for i := 0; i < emit; i++ {
				select {
				case ch <- struct{}{}:
				default:
					// Consumers are saturated; drop the token rather than
					// block the pacer. The RPS shortfall shows up in metrics.
					credit = 0
					i = emit
				}
			}
		}
	}()
	return ch
}

func isTimeout(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) {
		return netErr.Timeout()
	}
	return errors.Is(err, context.DeadlineExceeded)
}
