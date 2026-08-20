// Package env reads configuration from the process environment.
//
// It exists so the agent and the seeder resolve the same variables the same
// way. They address the same buckets with the same key layout, and a mismatch
// between them produces a run where every request 404s - an expensive way to
// discover a typo.
package env

import (
	"os"
	"strconv"
)

// String returns the value of key, or def when unset or empty.
func String(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// Int returns the value of key parsed as an integer.
//
// An unparseable value falls back to def rather than failing: these variables
// are written by a boot script, and a malformed one should not stop the agent
// from starting and reporting for duty.
func Int(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
