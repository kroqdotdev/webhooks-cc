package verify

import (
	"errors"
	"testing"
	"time"

	"webhooks.cc/go/internal/sigutil"
)

// An HMAC keyed with nothing can be computed by anyone, so a secret that
// decodes to an empty key must be refused, never accepted as a verdict.
func TestSecretsThatDecodeToNothingAreRefused(t *testing.T) {
	body := []byte(`{"type":"email.received","timestamp":"2026-01-01T00:00:00.000Z","data":{}}`)
	now := time.Unix(1767225600, 0)
	signed := Map{
		"webhook-id":        "msg_1",
		"webhook-timestamp": "1767225600",
		// HMAC-SHA256 with an empty key: what a forger would send.
		"webhook-signature":       "v1," + sigutil.Base64(sigutil.HMACSHA256(nil, append([]byte("msg_1.1767225600."), body...))),
		"svix-id":                 "msg_1",
		"svix-timestamp":          "1767225600",
		"svix-signature":          "v1," + sigutil.Base64(sigutil.HMACSHA256(nil, append([]byte("msg_1.1767225600."), body...))),
		"webhooks-cc-request-id":  "req_1",
		"webhooks-cc-received-at": "2026-01-01T00:00:00.000Z",
		"webhooks-cc-signature":   "v1," + sigutil.Base64(sigutil.HMACSHA256(nil, append([]byte("req_1.2026-01-01T00:00:00.000Z."), body...))),
	}
	for _, secret := range []string{"whsec_", " ", "whsec_\n"} {
		for _, provider := range []string{"standard-webhooks", "clerk", "resend"} {
			if valid, err := Signature(provider, body, signed, Options{Secret: secret}); valid || !errors.Is(err, sigutil.ErrEmptyKey) {
				t.Errorf("%s with %q: valid = %v, err = %v", provider, secret, valid, err)
			}
		}
		if _, err := ForwardedEmail(body, signed, secret, WithNow(now)); !errors.Is(err, sigutil.ErrEmptyKey) {
			t.Errorf("ForwardedEmail with %q: %v", secret, err)
		}
		if _, err := RelayedRequest(body, signed, secret); !errors.Is(err, sigutil.ErrEmptyKey) {
			t.Errorf("RelayedRequest with %q: %v", secret, err)
		}
	}
}
