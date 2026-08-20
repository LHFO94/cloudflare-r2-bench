package main

import (
	"math"
	"sync"
	"testing"
)

// bucketValue must be the inverse of bucketIndex: the value returned for a
// bucket has to land back in that same bucket.
func TestHistogramBucketRoundTrip(t *testing.T) {
	for i := 0; i < numBuckets; i++ {
		v := bucketValue(i)
		if got := bucketIndex(v); got != i {
			t.Fatalf("bucket %d has lower bound %d which maps to bucket %d", i, v, got)
		}
	}
}

// Bucket lower bounds must increase monotonically, otherwise quantiles are
// meaningless.
func TestHistogramBucketsMonotonic(t *testing.T) {
	prev := bucketValue(0)
	for i := 1; i < numBuckets; i++ {
		v := bucketValue(i)
		if v <= prev && i >= subCount {
			t.Fatalf("bucket %d lower bound %d not greater than previous %d", i, v, prev)
		}
		prev = v
	}
}

// Resolution guarantee: no bucket may be wider than 1/subCount (12.5%) of its
// own lower bound, so quantile error stays bounded.
func TestHistogramResolution(t *testing.T) {
	for i := subCount; i < numBuckets-1; i++ {
		lo := bucketValue(i)
		hi := bucketValue(i + 1)
		width := float64(hi-lo) / float64(lo)
		if width > 1.0/float64(subCount)+1e-9 {
			t.Fatalf("bucket %d spans %.4f of its lower bound (%d..%d), exceeding 1/%d",
				i, width, lo, hi, subCount)
		}
	}
}

func TestHistogramValuesLandInRange(t *testing.T) {
	for _, v := range []uint64{0, 1, 7, 8, 9, 15, 16, 17, 100, 999, 1000, 12345, 1_000_000, 30_000_000} {
		i := bucketIndex(v)
		lo := bucketValue(i)
		if v < lo {
			t.Errorf("value %d landed in bucket %d whose lower bound is %d", v, i, lo)
		}
		if i+1 < numBuckets {
			hi := bucketValue(i + 1)
			if v >= hi {
				t.Errorf("value %d landed in bucket %d but next bound is %d", v, i, hi)
			}
		}
	}
}

func TestQuantileApproximatesTruth(t *testing.T) {
	m := NewMetrics()
	// 1..1000 microseconds, uniform.
	for v := uint64(1); v <= 1000; v++ {
		m.ObserveSuccess(v, 0, 200)
	}
	s := m.Snapshot()

	for _, tc := range []struct{ q, want float64 }{
		{0.50, 500},
		{0.95, 950},
		{0.99, 990},
	} {
		got := s.Quantile(tc.q) * 1000.0 // back to microseconds
		// Allow one bucket width (12.5%) of error.
		if math.Abs(got-tc.want)/tc.want > 0.15 {
			t.Errorf("Quantile(%.2f) = %.1fus, want ~%.0fus", tc.q, got, tc.want)
		}
	}
}

func TestMeanLatencyIncludesErrors(t *testing.T) {
	m := NewMetrics()
	m.ObserveSuccess(1000, 10, 200) // 1ms
	m.ObserveError(3000, false)     // 3ms
	s := m.Snapshot()

	if s.Count != 1 || s.Errors != 1 {
		t.Fatalf("unexpected counts: %d success, %d errors", s.Count, s.Errors)
	}
	if got := s.MeanLatencyMillis(); math.Abs(got-2.0) > 1e-9 {
		t.Errorf("MeanLatencyMillis() = %v, want 2.0 (errors must be included)", got)
	}
}

func TestSnapshotSubProducesDeltas(t *testing.T) {
	m := NewMetrics()
	for i := 0; i < 10; i++ {
		m.ObserveSuccess(1000, 100, 200)
	}
	first := m.Snapshot()

	for i := 0; i < 5; i++ {
		m.ObserveSuccess(2000, 100, 500)
	}
	second := m.Snapshot()

	d := second.Sub(first)
	if d.Count != 5 {
		t.Errorf("delta Count = %d, want 5", d.Count)
	}
	if d.Bytes != 500 {
		t.Errorf("delta Bytes = %d, want 500", d.Bytes)
	}
	if d.Status5x != 5 {
		t.Errorf("delta Status5x = %d, want 5", d.Status5x)
	}
	if d.StatusOK != 0 {
		t.Errorf("delta StatusOK = %d, want 0", d.StatusOK)
	}
}

func TestStatusClassification(t *testing.T) {
	m := NewMetrics()
	m.ObserveSuccess(100, 0, 200)
	m.ObserveSuccess(100, 0, 206)
	m.ObserveSuccess(100, 0, 404)
	m.ObserveSuccess(100, 0, 429)
	m.ObserveSuccess(100, 0, 500)
	s := m.Snapshot()

	if s.StatusOK != 2 || s.Status4x != 2 || s.Status5x != 1 {
		t.Errorf("classification wrong: ok=%d 4xx=%d 5xx=%d", s.StatusOK, s.Status4x, s.Status5x)
	}
}

// The hot path is touched by thousands of goroutines; verify no counts are lost.
func TestConcurrentObservationsAreExact(t *testing.T) {
	m := NewMetrics()
	const goroutines, perGoroutine = 64, 1000

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for g := 0; g < goroutines; g++ {
		go func() {
			defer wg.Done()
			for i := 0; i < perGoroutine; i++ {
				m.ObserveSuccess(1500, 1536, 200)
			}
		}()
	}
	wg.Wait()

	s := m.Snapshot()
	want := uint64(goroutines * perGoroutine)
	if s.Count != want {
		t.Errorf("Count = %d, want %d", s.Count, want)
	}
	if s.Bytes != want*1536 {
		t.Errorf("Bytes = %d, want %d", s.Bytes, want*1536)
	}
	var bucketTotal uint64
	for _, c := range s.Buckets {
		bucketTotal += c
	}
	if bucketTotal != want {
		t.Errorf("histogram total = %d, want %d", bucketTotal, want)
	}
}

func TestEmptySnapshotIsSafe(t *testing.T) {
	s := NewMetrics().Snapshot()
	if s.MeanLatencyMillis() != 0 {
		t.Error("mean of empty snapshot should be 0")
	}
	if s.Quantile(0.99) != 0 {
		t.Error("quantile of empty snapshot should be 0")
	}
}
