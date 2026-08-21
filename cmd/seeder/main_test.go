package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/LHFO94/cloudflare-r2-bench/internal/r2"
)

func newTestSeeder(t *testing.T, handler http.HandlerFunc, keyspace int) (*seeder, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	o := options{
		endpoint:     srv.URL,
		bucketPrefix: "b-",
		bucketCount:  1,
		keyPrefix:    "obj/",
		keyspace:     keyspace,
		objectSize:   16,
		concurrency:  4,
		region:       "auto",
	}
	return &seeder{
		opts: o,
		naming: r2.Naming{
			BucketPrefix: o.bucketPrefix,
			BucketCount:  o.bucketCount,
			KeyPrefix:    o.keyPrefix,
			Keyspace:     o.keyspace,
		},
		signer: r2.NewSigner("ak", "sk", o.region),
		client: srv.Client(),
	}, srv
}

// listPage returns one page per call; missingKeys must follow the continuation
// token rather than stopping at the first page, or a bucket with more than one
// page of objects looks almost entirely empty and gets needlessly rewritten.
func TestMissingKeysFollowsPagination(t *testing.T) {
	// 5 keys exist (0,1,3,4 and the sentinel); key 2 is absent.
	pages := []string{
		`<ListBucketResult><IsTruncated>true</IsTruncated>
		 <NextContinuationToken>tok2</NextContinuationToken>
		 <Contents><Key>obj/00000000</Key></Contents>
		 <Contents><Key>obj/00000001</Key></Contents></ListBucketResult>`,
		`<ListBucketResult><IsTruncated>false</IsTruncated>
		 <Contents><Key>obj/00000003</Key></Contents>
		 <Contents><Key>obj/00000004</Key></Contents>
		 <Contents><Key>obj/_seed_complete</Key></Contents></ListBucketResult>`,
	}
	var calls atomic.Int32
	s, _ := newTestSeeder(t, func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n == 1 && r.URL.Query().Get("continuation-token") != "" {
			t.Errorf("first page should not carry a continuation token")
		}
		if n == 2 && r.URL.Query().Get("continuation-token") != "tok2" {
			t.Errorf("second page token = %q, want tok2", r.URL.Query().Get("continuation-token"))
		}
		fmt.Fprint(w, pages[n-1])
	}, 5)

	missing, err := s.missingKeys(context.Background(), 0)
	if err != nil {
		t.Fatalf("missingKeys: %v", err)
	}
	if len(missing) != 1 || missing[0] != 2 {
		t.Errorf("missing = %v, want [2]", missing)
	}
	if calls.Load() != 2 {
		t.Errorf("made %d list calls, want 2", calls.Load())
	}
}

// The sentinel shares the object prefix, so a complete bucket lists one more
// key than the keyspace. Counting would be off by one; matching by key must
// not be.
func TestSentinelIsNotMistakenForAnObject(t *testing.T) {
	s, _ := newTestSeeder(t, func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<ListBucketResult><IsTruncated>false</IsTruncated>
		 <Contents><Key>obj/00000000</Key></Contents>
		 <Contents><Key>obj/00000001</Key></Contents>
		 <Contents><Key>obj/_seed_complete</Key></Contents></ListBucketResult>`)
	}, 2)

	missing, err := s.missingKeys(context.Background(), 0)
	if err != nil {
		t.Fatalf("missingKeys: %v", err)
	}
	if len(missing) != 0 {
		t.Errorf("missing = %v, want none", missing)
	}
}

// A failure in one bucket must not cost the sentinel of another. Losing every
// sentinel over a handful of bad objects forces a full reseed to repair them.
func TestCleanBucketsAreSentinelledDespiteAFailureElsewhere(t *testing.T) {
	var sentinelled []string
	s, _ := newTestSeeder(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "_seed_complete") {
			sentinelled = append(sentinelled, strings.Split(r.URL.Path, "/")[1])
		}
		w.WriteHeader(http.StatusOK)
	}, 4)
	s.opts.bucketCount = 3
	s.naming.BucketCount = 3
	s.failedPerBucket = make([]atomic.Uint64, 3)
	s.failedPerBucket[1].Add(7) // bucket 1 lost some objects

	if err := s.writeSentinels(context.Background(), []int{0, 1, 2}); err != nil {
		t.Fatalf("writeSentinels: %v", err)
	}

	want := []string{"b-00", "b-02"}
	if len(sentinelled) != len(want) {
		t.Fatalf("sentinelled %v, want %v", sentinelled, want)
	}
	for i := range want {
		if sentinelled[i] != want[i] {
			t.Errorf("sentinelled %v, want %v", sentinelled, want)
		}
	}
}

func TestQueryEscapeUsesPercentTwentyForSpace(t *testing.T) {
	if got := queryEscape("a b+c/d="); got != "a%20b%2Bc%2Fd%3D" {
		t.Errorf("queryEscape = %q, want a%%20b%%2Bc%%2Fd%%3D", got)
	}
}
