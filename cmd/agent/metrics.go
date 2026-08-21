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
	// Connections the transport had to dial rather than reuse. A healthy run
	// dials once during warmup and then reuses: a mid-run spike means the pool
	// is being drained and every fresh request is paying a TCP and TLS
	// handshake, which shows up as a throughput dip with a multi-second tail
	// but no errors. Without this the only symptom is the dip itself, which is
	// indistinguishable from the target slowing down.
	newConns    atomic.Uint64
	reusedConns atomic.Uint64
	// Time on the wire: from the last byte of the request to the first byte of
	// the response. Total latency also contains the delay between a worker
	// being handed a pacer token and the request actually being written, which
	// is agent scheduling cost, not R2. Under CPU saturation that delay
	// dominates, so a run can report seconds of "latency" while R2 is
	// answering in milliseconds. Comparing wire mean against latency mean is
	// the only way to tell those two apart from the outside.
	wireSum   atomic.Uint64
	wireCount atomic.Uint64
	buckets   [numBuckets]atomic.Uint64
}

// ObserveWire records server round-trip time for one request, measured between
// the httptrace WroteRequest and GotFirstResponseByte hooks.
func (m *Metrics) ObserveWire(micros uint64) {
	m.wireSum.Add(micros)
	m.wireCount.Add(1)
}

// ObserveConn records whether a request got an existing connection or dialled
// a new one. Called from the httptrace GotConn hook.
func (m *Metrics) ObserveConn(reused bool) {
	if reused {
		m.reusedConns.Add(1)
		return
	}
	m.newConns.Add(1)
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
	Count       uint64
	Errors      uint64
	Bytes       uint64
	LatSum      uint64
	StatusOK    uint64
	Status4x    uint64
	Status5x    uint64
	Timeouts    uint64
	NewConns    uint64
	ReusedConns uint64
	WireSum     uint64
	WireCount   uint64
	Buckets     [numBuckets]uint64
}

func (m *Metrics) Snapshot() Snapshot {
	s := Snapshot{
		Count:       m.count.Load(),
		Errors:      m.errors.Load(),
		Bytes:       m.bytes.Load(),
		LatSum:      m.latSum.Load(),
		StatusOK:    m.statusOK.Load(),
		Status4x:    m.status4x.Load(),
		Status5x:    m.status5x.Load(),
		Timeouts:    m.timeouts.Load(),
		NewConns:    m.newConns.Load(),
		ReusedConns: m.reusedConns.Load(),
		WireSum:     m.wireSum.Load(),
		WireCount:   m.wireCount.Load(),
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
		Count:       s.Count - prev.Count,
		Errors:      s.Errors - prev.Errors,
		Bytes:       s.Bytes - prev.Bytes,
		LatSum:      s.LatSum - prev.LatSum,
		StatusOK:    s.StatusOK - prev.StatusOK,
		Status4x:    s.Status4x - prev.Status4x,
		Status5x:    s.Status5x - prev.Status5x,
		Timeouts:    s.Timeouts - prev.Timeouts,
		NewConns:    s.NewConns - prev.NewConns,
		ReusedConns: s.ReusedConns - prev.ReusedConns,
		WireSum:     s.WireSum - prev.WireSum,
		WireCount:   s.WireCount - prev.WireCount,
	}
	for i := range s.Buckets {
		d.Buckets[i] = s.Buckets[i] - prev.Buckets[i]
	}
	return d
}

// MeanWireMillis returns the mean server round-trip time. Compare it against
// MeanLatencyMillis: if the two are close the agent is keeping up and the
// reported latency is R2's, and if latency is far larger the gap is queueing
// inside the agent and the latency figure says nothing about R2.
func (s Snapshot) MeanWireMillis() float64 {
	if s.WireCount == 0 {
		return 0
	}
	return float64(s.WireSum) / float64(s.WireCount) / 1000.0
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
