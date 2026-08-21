package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// An identity proxy in front of the control plane answers every request with a
// redirect to its login page. Following it yields HTML and a JSON decode error
// that says nothing about the real cause, which is what made this take a
// serial-console investigation the first time. The agent must report the
// redirect itself.
func TestPollReportsRedirectInsteadOfFollowingIt(t *testing.T) {
	login := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html><body>sign in</body></html>"))
	}))
	defer login.Close()

	var loginHits int
	guarded := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		loginHits++
		http.Redirect(w, &http.Request{}, login.URL+"/cdn-cgi/access/login", http.StatusFound)
	}))
	defer guarded.Close()

	client := NewControlClient(&Config{
		ControlPlaneURL: guarded.URL,
		AgentToken:      "token",
		AgentID:         "agent-0",
		AgentRegion:     "us-west2",
	})

	_, err := client.Poll(context.Background())
	if err == nil {
		t.Fatal("expected an error when the control plane redirects")
	}

	// The operator needs the status and the destination to know who to ask.
	for _, want := range []string{"302", "cdn-cgi/access/login"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
	// A JSON decode failure would mean the redirect was followed.
	if strings.Contains(err.Error(), "invalid character") {
		t.Errorf("redirect was followed and the body parsed: %v", err)
	}
	if loginHits != 1 {
		t.Errorf("expected exactly one request to the guarded endpoint, got %d", loginHits)
	}
}

// With a service token configured the agent must present it on every request,
// otherwise Access answers the poll with a login redirect.
func TestPollSendsAccessServiceTokenHeaders(t *testing.T) {
	var gotID, gotSecret string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotID = r.Header.Get("CF-Access-Client-Id")
		gotSecret = r.Header.Get("CF-Access-Client-Secret")
		_, _ = w.Write([]byte(`{"action":"idle"}`))
	}))
	defer srv.Close()

	client := NewControlClient(&Config{
		ControlPlaneURL:    srv.URL,
		AgentToken:         "token",
		AgentID:            "agent-0",
		AgentRegion:        "us-west2",
		AccessClientID:     "client.access",
		AccessClientSecret: "shhh",
	})

	if _, err := client.Poll(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if gotID != "client.access" || gotSecret != "shhh" {
		t.Errorf("headers not sent: id=%q secret=%q", gotID, gotSecret)
	}
}

// Without a token the headers must be absent rather than empty: an empty
// CF-Access-Client-Id is not equivalent to omitting it.
func TestPollOmitsAccessHeadersWhenUnset(t *testing.T) {
	var present bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, present = r.Header["Cf-Access-Client-Id"]
		_, _ = w.Write([]byte(`{"action":"idle"}`))
	}))
	defer srv.Close()

	client := NewControlClient(&Config{
		ControlPlaneURL: srv.URL,
		AgentToken:      "token",
		AgentID:         "agent-0",
		AgentRegion:     "us-west2",
	})

	if _, err := client.Poll(context.Background()); err != nil {
		t.Fatalf("poll: %v", err)
	}
	if present {
		t.Error("CF-Access-Client-Id sent despite no service token being configured")
	}
}

// When credentials were supplied and Access still redirects, the operator needs
// to be pointed at the policy rather than back at the credentials.
func TestRedirectErrorDistinguishesRejectedServiceToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "https://team.cloudflareaccess.com/cdn-cgi/access/login")
		w.WriteHeader(http.StatusFound)
	}))
	defer srv.Close()

	client := NewControlClient(&Config{
		ControlPlaneURL:    srv.URL,
		AgentToken:         "token",
		AgentID:            "agent-0",
		AgentRegion:        "us-west2",
		AccessClientID:     "client.access",
		AccessClientSecret: "shhh",
	})

	_, err := client.Poll(context.Background())
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "Service Auth policy") {
		t.Errorf("error should point at the policy, got: %v", err)
	}
}

// Non-redirect failures must keep reporting the body, which is where the
// control plane puts its own error messages.
func TestPollReportsBodyOnServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"bad agent token"}`))
	}))
	defer srv.Close()

	client := NewControlClient(&Config{
		ControlPlaneURL: srv.URL,
		AgentToken:      "wrong",
		AgentID:         "agent-0",
		AgentRegion:     "us-west2",
	})

	_, err := client.Poll(context.Background())
	if err == nil {
		t.Fatal("expected an error on 403")
	}
	if !strings.Contains(err.Error(), "bad agent token") {
		t.Errorf("error %q does not include the response body", err)
	}
}
