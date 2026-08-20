package main

import (
	"math/bits"
	"sync/atomic"
)

// subBits controls histogram resolution: 2^subBits sub-buckets per octave,
// giving ~1/8 = 12.5% worst-case bucket width. 256 buckets covers microsecond
// latencies up to ~4.5 hours, far beyond any request timeout.
const (
	subBits    = 3
	subCount   = 1 << subBits
	numBuckets = 256
)

// Metrics is a lock-free counter set shared by all worker goroutines.
// Every field is updated with atomics on the hot path; snapshots are taken
// by the reporter goroutine on a timer.
type Metrics struct {
	count    atomic.Uint64
	errors   atomic.Uint64
	bytes    atomic.Uint64
	latSum   atomic.Uint64 // total latency in microseconds
	statusOK atomic.Uint64
	status4x atomic.Uint64
	status5x atomic.Uint64
	timeouts atomic.Uint64
	buckets  [numBuckets]atomic.Uint64
}

func NewMetrics() *Metrics { return &Metrics{} }

// ObserveSuccess records a completed request. latencyMicros is wall time from
// request start to fully drained body.
func (m *Metrics) ObserveSuccess(latencyMicros uint64, n int64, status int) {
	m.count.Add(1)
	m.latSum.Add(latencyMicros)
	m.bytes.Add(uint64(n))
	m.buckets[bucketIndex(latencyMicros)].Add(1)
	switch {
	case status < 400:
		m.statusOK.Add(1)
	case status < 500:
		m.status4x.Add(1)
	default:
		m.status5x.Add(1)
	}
}

// ObserveError records a request that never produced a usable response.
func (m *Metrics) ObserveError(latencyMicros uint64, timeout bool) {
	m.errors.Add(1)
	m.latSum.Add(latencyMicros)
	m.buckets[bucketIndex(latencyMicros)].Add(1)
	if timeout {
		m.timeouts.Add(1)
	}
}

// Snapshot is a point-in-time read of the cumulative counters.
type Snapshot struct {
	Count    uint64
	Errors   uint64
	Bytes    uint64
	LatSum   uint64
	StatusOK uint64
	Status4x uint64
	Status5x uint64
	Timeouts uint64
	Buckets  [numBuckets]uint64
}

func (m *Metrics) Snapshot() Snapshot {
	s := Snapshot{
		Count:    m.count.Load(),
		Errors:   m.errors.Load(),
		Bytes:    m.bytes.Load(),
		LatSum:   m.latSum.Load(),
		StatusOK: m.statusOK.Load(),
		Status4x: m.status4x.Load(),
		Status5x: m.status5x.Load(),
		Timeouts: m.timeouts.Load(),
	}
	for i := range m.buckets {
		s.Buckets[i] = m.buckets[i].Load()
	}
	return s
}

// Sub returns the delta between two cumulative snapshots, for per-interval
// reporting. Counters are monotonic so this is always non-negative.
func (s Snapshot) Sub(prev Snapshot) Snapshot {
	d := Snapshot{
		Count:    s.Count - prev.Count,
		Errors:   s.Errors - prev.Errors,
		Bytes:    s.Bytes - prev.Bytes,
		LatSum:   s.LatSum - prev.LatSum,
		StatusOK: s.StatusOK - prev.StatusOK,
		Status4x: s.Status4x - prev.Status4x,
		Status5x: s.Status5x - prev.Status5x,
		Timeouts: s.Timeouts - prev.Timeouts,
	}
	for i := range s.Buckets {
		d.Buckets[i] = s.Buckets[i] - prev.Buckets[i]
	}
	return d
}

// MeanLatencyMillis returns the arithmetic mean over all observations.
func (s Snapshot) MeanLatencyMillis() float64 {
	total := s.Count + s.Errors
	if total == 0 {
		return 0
	}
	return float64(s.LatSum) / float64(total) / 1000.0
}

// Quantile returns the approximate latency in milliseconds at q (0..1).
func (s Snapshot) Quantile(q float64) float64 {
	var total uint64
	for _, c := range s.Buckets {
		total += c
	}
	if total == 0 {
		return 0
	}
	target := uint64(q * float64(total))
	var cum uint64
	for i, c := range s.Buckets {
		cum += c
		if cum >= target {
			return float64(bucketValue(i)) / 1000.0
		}
	}
	return float64(bucketValue(numBuckets-1)) / 1000.0
}

// bucketIndex maps a value to its histogram bucket using a linear region
// below subCount and a log-linear region above it.
func bucketIndex(v uint64) int {
	if v < subCount {
		return int(v)
	}
	e := uint(bits.Len64(v) - 1)
	m := (v >> (e - subBits)) & (subCount - 1)
	idx := int(((uint64(e) - subBits + 1) << subBits) | m)
	if idx >= numBuckets {
		return numBuckets - 1
	}
	return idx
}

// bucketValue is the inverse of bucketIndex, returning the lower bound of the
// bucket. Used to convert quantile bucket positions back to latencies.
func bucketValue(i int) uint64 {
	if i < subCount {
		return uint64(i)
	}
	e := uint(i>>subBits) + subBits - 1
	m := uint64(i & (subCount - 1))
	return (subCount | m) << (e - subBits)
}
