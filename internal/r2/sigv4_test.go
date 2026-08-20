package r2

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// referenceSign is an intentionally naive, independent implementation of the
// same SigV4 flow. It builds strings with fmt.Sprintf and re-derives the
// signing key from scratch every call. The production Signer uses a
// strings.Builder and caches the derived key, so comparing the two catches
// bugs in either the string assembly or the cache.
func referenceSign(method, accessKey, secretKey, region, host, path, query, payloadHash string, ts time.Time) string {
	amzDate := ts.UTC().Format("20060102T150405Z")
	dateStamp := amzDate[:8]

	canonical := fmt.Sprintf("%s\n%s\n%s\nhost:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n\n%s\n%s",
		method, path, query, host, payloadHash, amzDate,
		"host;x-amz-content-sha256;x-amz-date", payloadHash)

	sum := sha256.Sum256([]byte(canonical))
	scope := fmt.Sprintf("%s/%s/s3/aws4_request", dateStamp, region)
	stringToSign := fmt.Sprintf("AWS4-HMAC-SHA256\n%s\n%s\n%s", amzDate, scope, hex.EncodeToString(sum[:]))

	mac := func(key []byte, data string) []byte {
		h := hmac.New(sha256.New, key)
		h.Write([]byte(data))
		return h.Sum(nil)
	}
	k := mac(mac(mac(mac([]byte("AWS4"+secretKey), dateStamp), region), "s3"), "aws4_request")
	sig := hex.EncodeToString(mac(k, stringToSign))

	return fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		accessKey, scope, "host;x-amz-content-sha256;x-amz-date", sig)
}

const (
	testAccessKey = "AKIDEXAMPLE"
	testSecretKey = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
	testRegion    = "auto"
	testHost      = "abc123.r2.cloudflarestorage.com"
)

func TestSignGetMatchesReference(t *testing.T) {
	signer := NewSigner(testAccessKey, testSecretKey, testRegion)
	ts := time.Date(2026, 8, 20, 12, 36, 0, 0, time.UTC)

	for _, path := range []string{
		"/r2bench-00/obj/00000001",
		"/r2bench-24/obj/00039999",
		"/r2bench-07/obj/00000000",
	} {
		req, err := http.NewRequest(http.MethodGet, "https://"+testHost+path, nil)
		if err != nil {
			t.Fatalf("building request for %s: %v", path, err)
		}
		signer.Sign(req, EmptyPayloadSHA256, ts)

		got := req.Header.Get("Authorization")
		want := referenceSign("GET", testAccessKey, testSecretKey, testRegion, testHost, path, "", EmptyPayloadSHA256, ts)
		if got != want {
			t.Errorf("path %s:\n got: %s\nwant: %s", path, got, want)
		}
		if req.Header.Get("x-amz-date") != "20260820T123600Z" {
			t.Errorf("path %s: unexpected x-amz-date %q", path, req.Header.Get("x-amz-date"))
		}
	}
}

// The seeder signs PUTs with a real payload hash, so the method and hash must
// both feed into the signature.
func TestSignPutMatchesReference(t *testing.T) {
	signer := NewSigner(testAccessKey, testSecretKey, testRegion)
	ts := time.Date(2026, 8, 20, 12, 36, 0, 0, time.UTC)
	body := []byte("some object payload")
	hash := HashBytes(body)

	path := "/r2bench-03/obj/00001234"
	req, err := http.NewRequest(http.MethodPut, "https://"+testHost+path, strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("building request: %v", err)
	}
	signer.Sign(req, hash, ts)

	got := req.Header.Get("Authorization")
	want := referenceSign("PUT", testAccessKey, testSecretKey, testRegion, testHost, path, "", hash, ts)
	if got != want {
		t.Errorf("\n got: %s\nwant: %s", got, want)
	}
	if req.Header.Get("x-amz-content-sha256") != hash {
		t.Error("payload hash header not set to the provided hash")
	}
}

func TestHashBytesMatchesEmptyConstant(t *testing.T) {
	if got := HashBytes(nil); got != EmptyPayloadSHA256 {
		t.Errorf("HashBytes(nil) = %s, want %s", got, EmptyPayloadSHA256)
	}
}

// TestSigningKeyCacheRotates guards the daily key cache: the same date must
// reuse the key, and a new date must derive a fresh one.
func TestSigningKeyCacheRotates(t *testing.T) {
	s := NewSigner("AKID", "SECRET", "auto")

	day1a := s.signingKey("20260820")
	day1b := s.signingKey("20260820")
	if !hmac.Equal(day1a, day1b) {
		t.Fatal("same date returned different signing keys")
	}

	day2 := s.signingKey("20260821")
	if hmac.Equal(day1a, day2) {
		t.Fatal("different dates returned the same signing key")
	}

	// Re-deriving an earlier date must recompute rather than return stale bytes.
	if back := s.signingKey("20260820"); !hmac.Equal(back, day1a) {
		t.Fatal("re-deriving an earlier date produced a different key")
	}
}

// The cache is read concurrently by every worker goroutine.
func TestSigningKeyCacheConcurrent(t *testing.T) {
	s := NewSigner("AKID", "SECRET", "auto")
	want := NewSigner("AKID", "SECRET", "auto").signingKey("20260820")

	done := make(chan bool, 32)
	for i := 0; i < 32; i++ {
		go func(i int) {
			// Half the goroutines force a different date to exercise eviction.
			date := "20260820"
			if i%2 == 1 {
				date = "20260821"
			}
			k := s.signingKey(date)
			if date == "20260820" {
				done <- hmac.Equal(k, want)
				return
			}
			done <- len(k) == 32
		}(i)
	}
	for i := 0; i < 32; i++ {
		if !<-done {
			t.Fatal("concurrent signingKey returned an incorrect key")
		}
	}
}

func TestSignatureChangesWithInput(t *testing.T) {
	s := NewSigner("AKID", "SECRET", "auto")
	ts := time.Date(2026, 8, 20, 12, 0, 0, 0, time.UTC)

	sign := func(method, url, hash string, at time.Time) string {
		req, _ := http.NewRequest(method, url, nil)
		s.Sign(req, hash, at)
		return req.Header.Get("Authorization")
	}

	base := sign("GET", "https://h.example.com/b/k", EmptyPayloadSHA256, ts)
	for name, got := range map[string]string{
		"key":       sign("GET", "https://h.example.com/b/k2", EmptyPayloadSHA256, ts),
		"host":      sign("GET", "https://h2.example.com/b/k", EmptyPayloadSHA256, ts),
		"timestamp": sign("GET", "https://h.example.com/b/k", EmptyPayloadSHA256, ts.Add(time.Second)),
		"method":    sign("PUT", "https://h.example.com/b/k", EmptyPayloadSHA256, ts),
		"payload":   sign("GET", "https://h.example.com/b/k", HashBytes([]byte("x")), ts),
	} {
		if got == base {
			t.Errorf("signature did not change when %s changed", name)
		}
	}
}

func TestURIEncodePath(t *testing.T) {
	cases := map[string]string{
		"":                    "/",
		"/obj/00000001":       "/obj/00000001",
		"/a-b_c.d~e/f":        "/a-b_c.d~e/f",
		"/has space":          "/has%20space",
		"/plus+and&amp":       "/plus%2Band%26amp",
		"/unicode-\u00e9":     "/unicode-%C3%A9",
		"/pct%char":           "/pct%25char",
		"/keep/slashes/here/": "/keep/slashes/here/",
	}
	for in, want := range cases {
		if got := uriEncodePath(in); got != want {
			t.Errorf("uriEncodePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestURIEncodeFastPathConsistency(t *testing.T) {
	unreserved := "/abcXYZ019-_.~/"
	if got := uriEncodePath(unreserved); got != unreserved {
		t.Fatalf("fast path altered an already-safe string: %q", got)
	}
	if strings.ContainsAny(uriEncodePath("/safe"), "%") {
		t.Fatal("fast path introduced escaping")
	}
}
