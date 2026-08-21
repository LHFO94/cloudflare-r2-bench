package main

import (
	"strings"
	"testing"
)

// A half-configured service token is worse than none: Access ignores the lone
// header and replies with a login redirect, which is indistinguishable from
// having configured nothing. Catch it at startup.
func TestConfigRejectsHalfAnAccessServiceToken(t *testing.T) {
	base := map[string]string{
		"R2_ENDPOINT":          "https://acct.r2.cloudflarestorage.com",
		"R2_ACCESS_KEY_ID":     "id",
		"R2_SECRET_ACCESS_KEY": "secret",
		"CONTROL_PLANE_URL":    "https://cp.example.workers.dev",
		"AGENT_TOKEN":          "token",
	}

	for name, extra := range map[string]map[string]string{
		"only id":     {"CF_ACCESS_CLIENT_ID": "client.access"},
		"only secret": {"CF_ACCESS_CLIENT_SECRET": "shhh"},
	} {
		t.Run(name, func(t *testing.T) {
			for k, v := range base {
				t.Setenv(k, v)
			}
			for k, v := range extra {
				t.Setenv(k, v)
			}
			_, err := LoadConfig()
			if err == nil {
				t.Fatal("expected an error for a half-configured service token")
			}
			if !strings.Contains(err.Error(), "must be set together") {
				t.Errorf("unhelpful error: %v", err)
			}
		})
	}
}

func TestConfigAcceptsBothOrNeitherAccessCredential(t *testing.T) {
	base := map[string]string{
		"R2_ENDPOINT":          "https://acct.r2.cloudflarestorage.com",
		"R2_ACCESS_KEY_ID":     "id",
		"R2_SECRET_ACCESS_KEY": "secret",
		"CONTROL_PLANE_URL":    "https://cp.example.workers.dev",
		"AGENT_TOKEN":          "token",
	}

	for name, extra := range map[string]map[string]string{
		"neither": {},
		"both":    {"CF_ACCESS_CLIENT_ID": "client.access", "CF_ACCESS_CLIENT_SECRET": "shhh"},
	} {
		t.Run(name, func(t *testing.T) {
			for k, v := range base {
				t.Setenv(k, v)
			}
			for k, v := range extra {
				t.Setenv(k, v)
			}
			if _, err := LoadConfig(); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
