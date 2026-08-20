// Package r2 holds the pieces shared by the load agent and the seeder:
// AWS SigV4 request signing and the deterministic bucket/key naming scheme.
package r2

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"
)

// EmptyPayloadSHA256 is SHA256(""), the payload hash for any bodyless request.
const EmptyPayloadSHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const (
	algorithm     = "AWS4-HMAC-SHA256"
	signedHeaders = "host;x-amz-content-sha256;x-amz-date"
)

// Signer produces AWS SigV4 signatures for S3 requests.
//
// The derived signing key only changes once per UTC day, so it is cached.
// At 10k RPS that removes 40k HMAC operations per second versus deriving it
// per request. The cache is safe for concurrent use.
type Signer struct {
	accessKey string
	secretKey string
	region    string
	service   string

	mu         sync.RWMutex
	cachedDate string
	cachedKey  []byte
}

func NewSigner(accessKey, secretKey, region string) *Signer {
	return &Signer{
		accessKey: accessKey,
		secretKey: secretKey,
		region:    region,
		service:   "s3",
	}
}

func (s *Signer) signingKey(dateStamp string) []byte {
	s.mu.RLock()
	if s.cachedDate == dateStamp {
		k := s.cachedKey
		s.mu.RUnlock()
		return k
	}
	s.mu.RUnlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cachedDate == dateStamp {
		return s.cachedKey
	}
	kDate := hmacSHA256([]byte("AWS4"+s.secretKey), dateStamp)
	kRegion := hmacSHA256(kDate, s.region)
	kService := hmacSHA256(kRegion, s.service)
	s.cachedKey = hmacSHA256(kService, "aws4_request")
	s.cachedDate = dateStamp
	return s.cachedKey
}

// Sign adds x-amz-date, x-amz-content-sha256 and Authorization to req.
// payloadSHA256 must be the hex SHA256 of the request body, or
// EmptyPayloadSHA256 for bodyless requests.
func (s *Signer) Sign(req *http.Request, payloadSHA256 string, now time.Time) {
	amzDate := now.UTC().Format("20060102T150405Z")
	dateStamp := amzDate[:8]

	host := req.Host
	if host == "" {
		host = req.URL.Host
	}

	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadSHA256)

	var cr strings.Builder
	cr.Grow(320)
	cr.WriteString(req.Method)
	cr.WriteString("\n")
	cr.WriteString(uriEncodePath(req.URL.Path))
	cr.WriteString("\n")
	cr.WriteString(req.URL.RawQuery)
	cr.WriteString("\nhost:")
	cr.WriteString(host)
	cr.WriteString("\nx-amz-content-sha256:")
	cr.WriteString(payloadSHA256)
	cr.WriteString("\nx-amz-date:")
	cr.WriteString(amzDate)
	cr.WriteString("\n\n")
	cr.WriteString(signedHeaders)
	cr.WriteString("\n")
	cr.WriteString(payloadSHA256)

	crHash := sha256.Sum256([]byte(cr.String()))
	scope := dateStamp + "/" + s.region + "/" + s.service + "/aws4_request"

	var sts strings.Builder
	sts.Grow(160)
	sts.WriteString(algorithm)
	sts.WriteString("\n")
	sts.WriteString(amzDate)
	sts.WriteString("\n")
	sts.WriteString(scope)
	sts.WriteString("\n")
	sts.WriteString(hex.EncodeToString(crHash[:]))

	signature := hex.EncodeToString(hmacSHA256(s.signingKey(dateStamp), sts.String()))

	var auth strings.Builder
	auth.Grow(224)
	auth.WriteString(algorithm)
	auth.WriteString(" Credential=")
	auth.WriteString(s.accessKey)
	auth.WriteString("/")
	auth.WriteString(scope)
	auth.WriteString(", SignedHeaders=")
	auth.WriteString(signedHeaders)
	auth.WriteString(", Signature=")
	auth.WriteString(signature)

	req.Header.Set("Authorization", auth.String())
}

// HashBytes returns the hex SHA256 of b, for signing requests with a body.
func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// uriEncodePath percent-encodes a path per RFC 3986 while preserving "/".
// S3 requires the canonical URI to be encoded exactly this way.
func uriEncodePath(path string) string {
	if path == "" {
		return "/"
	}
	// Fast path: generated keys are unreserved characters plus "/".
	needsEncoding := false
	for i := 0; i < len(path); i++ {
		if !isUnreservedOrSlash(path[i]) {
			needsEncoding = true
			break
		}
	}
	if !needsEncoding {
		return path
	}

	const upperhex = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(path) * 2)
	for i := 0; i < len(path); i++ {
		ch := path[i]
		if isUnreservedOrSlash(ch) {
			b.WriteByte(ch)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(upperhex[ch>>4])
		b.WriteByte(upperhex[ch&0x0f])
	}
	return b.String()
}

func isUnreservedOrSlash(c byte) bool {
	switch {
	case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		return true
	case c == '-', c == '_', c == '.', c == '~', c == '/':
		return true
	}
	return false
}
