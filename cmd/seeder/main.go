// Command seeder populates R2 buckets with the fixed-size objects the load
// agent reads.
//
// Every PUT is a billable Class A operation, so the seeder writes a sentinel
// object once a bucket is fully populated and skips buckets whose sentinel
// already matches the requested shape. Use -force to reseed regardless.
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/LHFO94/cloudflare-r2-bench/internal/env"
	"github.com/LHFO94/cloudflare-r2-bench/internal/r2"
)

type options struct {
	endpoint     string
	bucketPrefix string
	bucketCount  int
	keyPrefix    string
	keyspace     int
	objectSize   int
	concurrency  int
	region       string
	force        bool
	dryRun       bool
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("[seeder] ")

	// Flags default to the same R2_* variables the agent reads, so exporting
	// one environment (from `terraform output seed_command`) guarantees the
	// seeder and the agent agree on bucket names and key layout. Getting that
	// wrong yields a run where every GET is a 404.
	var o options
	flag.StringVar(&o.endpoint, "endpoint", os.Getenv("R2_ENDPOINT"), "S3 endpoint (default $R2_ENDPOINT)")
	flag.StringVar(&o.bucketPrefix, "bucket-prefix", env.String("R2_BUCKET_PREFIX", "r2bench-"), "bucket name prefix (default $R2_BUCKET_PREFIX)")
	flag.IntVar(&o.bucketCount, "bucket-count", env.Int("R2_BUCKET_COUNT", 25), "number of buckets (default $R2_BUCKET_COUNT)")
	flag.StringVar(&o.keyPrefix, "key-prefix", env.String("R2_KEY_PREFIX", "obj/"), "object key prefix (default $R2_KEY_PREFIX)")
	flag.IntVar(&o.keyspace, "keyspace", env.Int("R2_KEYSPACE", 40000), "objects per bucket (default $R2_KEYSPACE)")
	flag.IntVar(&o.objectSize, "object-size", env.Int("R2_OBJECT_SIZE", 1536), "object size in bytes (default $R2_OBJECT_SIZE)")
	flag.IntVar(&o.concurrency, "concurrency", env.Int("SEEDER_CONCURRENCY", 256), "parallel PUTs")
	flag.StringVar(&o.region, "region", env.String("R2_REGION", "auto"), "S3 region")
	flag.BoolVar(&o.force, "force", false, "reseed buckets even if the sentinel matches")
	flag.BoolVar(&o.dryRun, "dry-run", false, "report what would be written and exit")
	flag.Parse()

	accessKey := os.Getenv("R2_ACCESS_KEY_ID")
	secretKey := os.Getenv("R2_SECRET_ACCESS_KEY")

	if o.endpoint == "" || accessKey == "" || secretKey == "" {
		log.Fatal("R2_ENDPOINT (or -endpoint), R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required")
	}
	if o.bucketCount <= 0 || o.keyspace <= 0 || o.objectSize <= 0 || o.concurrency <= 0 {
		log.Fatal("-bucket-count, -keyspace, -object-size and -concurrency must all be > 0")
	}
	o.endpoint = strings.TrimRight(o.endpoint, "/")

	naming := r2.Naming{
		BucketPrefix: o.bucketPrefix,
		BucketCount:  o.bucketCount,
		KeyPrefix:    o.keyPrefix,
		Keyspace:     o.keyspace,
	}

	totalObjects := o.bucketCount * o.keyspace
	totalBytes := int64(totalObjects) * int64(o.objectSize)
	log.Printf("target: %d buckets x %d objects x %d bytes = %d objects, %.2f GB",
		o.bucketCount, o.keyspace, o.objectSize, totalObjects, float64(totalBytes)/1e9)
	log.Printf("estimated Class A cost: $%.2f (at $4.50 per million)", float64(totalObjects)/1e6*4.50)

	if o.dryRun {
		for i := 0; i < min(o.bucketCount, 3); i++ {
			log.Printf("would seed %s with %s .. %s", naming.BucketName(i),
				naming.ObjectKey(0), naming.ObjectKey(o.keyspace-1))
		}
		log.Print("dry run, nothing written")
		return
	}

	s := &seeder{
		opts:   o,
		naming: naming,
		signer: r2.NewSigner(accessKey, secretKey, o.region),
		client: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				ForceAttemptHTTP2:   false,
				MaxIdleConnsPerHost: o.concurrency,
				MaxConnsPerHost:     0,
				IdleConnTimeout:     90 * time.Second,
				DisableCompression:  true,
			},
		},
	}

	ctx := context.Background()
	start := time.Now()
	if err := s.run(ctx); err != nil {
		log.Fatalf("seeding failed: %v", err)
	}
	log.Printf("done in %s", time.Since(start).Round(time.Second))
}

type seeder struct {
	opts   options
	naming r2.Naming
	signer *r2.Signer
	client *http.Client

	written atomic.Uint64
	failed  atomic.Uint64
}

type job struct {
	bucket int
	key    int
}

func (s *seeder) run(ctx context.Context) error {
	buckets := s.bucketsToSeed(ctx)
	if len(buckets) == 0 {
		log.Print("all buckets already seeded; use -force to reseed")
		return nil
	}
	log.Printf("seeding %d of %d buckets", len(buckets), s.opts.bucketCount)

	jobs := make(chan job, s.opts.concurrency*2)
	var wg sync.WaitGroup
	wg.Add(s.opts.concurrency)
	for i := 0; i < s.opts.concurrency; i++ {
		go func() {
			defer wg.Done()
			s.worker(ctx, jobs)
		}()
	}

	done := make(chan struct{})
	go s.progress(done, uint64(len(buckets)*s.opts.keyspace))

	for _, b := range buckets {
		for k := 0; k < s.opts.keyspace; k++ {
			jobs <- job{bucket: b, key: k}
		}
	}
	close(jobs)
	wg.Wait()
	close(done)

	if failed := s.failed.Load(); failed > 0 {
		return fmt.Errorf("%d objects failed to write", failed)
	}

	// Only mark buckets complete once every object landed.
	for _, b := range buckets {
		if err := s.writeSentinel(ctx, b); err != nil {
			return fmt.Errorf("writing sentinel for %s: %w", s.naming.BucketName(b), err)
		}
	}
	log.Printf("wrote %d objects across %d buckets", s.written.Load(), len(buckets))
	return nil
}

// bucketsToSeed returns the indices that still need populating.
func (s *seeder) bucketsToSeed(ctx context.Context) []int {
	if s.opts.force {
		all := make([]int, s.opts.bucketCount)
		for i := range all {
			all[i] = i
		}
		return all
	}

	want := s.naming.SentinelBody(s.opts.objectSize)
	var todo []int
	for i := 0; i < s.opts.bucketCount; i++ {
		body, err := s.get(ctx, i, s.naming.SentinelKey())
		if err != nil || string(body) != want {
			todo = append(todo, i)
			continue
		}
		log.Printf("%s already seeded, skipping", s.naming.BucketName(i))
	}
	return todo
}

func (s *seeder) worker(ctx context.Context, jobs <-chan job) {
	// Each worker owns its buffer so the payload can be mutated per object
	// without synchronisation.
	buf := make([]byte, s.opts.objectSize)
	fillDeterministic(buf)

	for j := range jobs {
		// Vary the leading bytes per object so stored objects are not all
		// byte-identical.
		if len(buf) >= 8 {
			binary.BigEndian.PutUint32(buf[0:4], uint32(j.bucket))
			binary.BigEndian.PutUint32(buf[4:8], uint32(j.key))
		}

		if err := s.putWithRetry(ctx, j.bucket, s.naming.ObjectKey(j.key), buf); err != nil {
			if s.failed.Add(1) <= 10 {
				log.Printf("PUT %s/%s failed: %v", s.naming.BucketName(j.bucket), s.naming.ObjectKey(j.key), err)
			}
			continue
		}
		s.written.Add(1)
	}
}

func (s *seeder) putWithRetry(ctx context.Context, bucketIdx int, key string, body []byte) error {
	const attempts = 4
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(1<<attempt)*100*time.Millisecond +
				time.Duration(rand.IntN(100))*time.Millisecond
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(backoff):
			}
		}
		if err := s.put(ctx, bucketIdx, key, body); err != nil {
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

func (s *seeder) put(ctx context.Context, bucketIdx int, key string, body []byte) error {
	url := fmt.Sprintf("%s/%s/%s", s.opts.endpoint, s.naming.BucketName(bucketIdx), key)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	s.signer.Sign(req, r2.HashBytes(body), time.Now())

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

func (s *seeder) get(ctx context.Context, bucketIdx int, key string) ([]byte, error) {
	url := fmt.Sprintf("%s/%s/%s", s.opts.endpoint, s.naming.BucketName(bucketIdx), key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	s.signer.Sign(req, r2.EmptyPayloadSHA256, time.Now())

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return body, nil
}

func (s *seeder) writeSentinel(ctx context.Context, bucketIdx int) error {
	body := []byte(s.naming.SentinelBody(s.opts.objectSize))
	return s.putWithRetry(ctx, bucketIdx, s.naming.SentinelKey(), body)
}

func (s *seeder) progress(done <-chan struct{}, total uint64) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	start := time.Now()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
		}
		w := s.written.Load()
		elapsed := time.Since(start).Seconds()
		rate := float64(w) / elapsed
		var eta string
		if rate > 0 && w < total {
			eta = (time.Duration(float64(total-w)/rate) * time.Second).Round(time.Second).String()
		} else {
			eta = "-"
		}
		log.Printf("progress: %d/%d objects (%.1f%%), %.0f PUT/s, %d failed, eta %s",
			w, total, float64(w)/float64(total)*100, rate, s.failed.Load(), eta)
	}
}

// fillDeterministic writes reproducible pseudo-random bytes. Random-looking
// payloads avoid any compression or dedupe effects that a buffer of zeros
// might trigger.
func fillDeterministic(b []byte) {
	rng := rand.New(rand.NewPCG(0x5eed, 0xb0a7))
	for i := 0; i+8 <= len(b); i += 8 {
		binary.LittleEndian.PutUint64(b[i:], rng.Uint64())
	}
	for i := len(b) - len(b)%8; i < len(b); i++ {
		b[i] = byte(rng.Uint32())
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
