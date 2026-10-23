package sigutil

import (
	"bytes"
	"testing"

	"webhooks.cc/go/internal/jsonx"
)

func TestDecodeBase64IsForgivingLikeAtob(t *testing.T) {
	valid := map[string]string{
		"aGk=":       "hi",
		"aGk":        "hi",
		" a G k = ":  "hi",
		"aGl=":       "hi", // leftover bits are ignored
		"":           "",
		"YWJjZA==":   "abcd",
		"YWJjZA":     "abcd",
		"YW\nJjZA==": "abcd",
	}
	for input, want := range valid {
		got, err := DecodeBase64(input)
		if err != nil || string(got) != want {
			t.Errorf("DecodeBase64(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"a", "aGk==", "a=Gk", "aG-k", "aG_k", "YWJjZA=", "aGk=="} {
		if _, err := DecodeBase64(input); err == nil {
			t.Errorf("DecodeBase64(%q) succeeded, want an error", input)
		}
	}
}

func TestStandardWebhookKey(t *testing.T) {
	if got := StandardWebhookKey("whsec_aGk="); string(got) != "hi" {
		t.Errorf("got %q", got)
	}
	if got := StandardWebhookKey("whsec_not base64!"); string(got) != "whsec_not base64!" {
		t.Errorf("got %q", got)
	}
}

func TestTwilioPayloadSortsByUTF16(t *testing.T) {
	// U+FF5E sorts after U+1F600 by code point, but before it by UTF-16 code unit.
	got := TwilioPayload("https://example.com/x", [][2]string{{"b", "2"}, {"\U0001F600", "1"}, {"a", "z"}, {"a", "y"}, {"～", "3"}})
	want := "https://example.com/xayaz" + "b2" + "\U0001F6001" + "～3"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestHubSpotDecodeURI(t *testing.T) {
	got := HubSpotDecodeURI("https://example.com/a%3Ab%2fc%20d%40e")
	if want := "https://example.com/a:b%2fc%20d@e"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestAdyenDataToSign(t *testing.T) {
	item, err := jsonx.Parse([]byte(`{"pspReference":"7914073381342284","merchantAccountCode":"AcmeShop","merchantReference":"TestPayment-1407325143704","amount":{"value":1130,"currency":"EUR"},"eventCode":"AUTHORISATION","success":"true"}`))
	if err != nil {
		t.Fatal(err)
	}
	got := AdyenDataToSign(item.(jsonx.Object))
	if want := "7914073381342284::AcmeShop:TestPayment-1407325143704:1130:EUR:AUTHORISATION:true"; got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if _, err := AdyenHMAC(item.(jsonx.Object), "zz"); err == nil {
		t.Error("a non-hex key should fail")
	}
}

func TestHMAC(t *testing.T) {
	// RFC 4231 test case 2.
	got := Hex(HMACSHA256([]byte("Jefe"), []byte("what do ya want for nothing?")))
	if want := "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"; got != want {
		t.Errorf("got %s", got)
	}
	if !bytes.Equal(HMACSHA1([]byte("k"), []byte("p")), HMACSHA1([]byte("k"), []byte("p"))) {
		t.Error("HMACSHA1 is not deterministic")
	}
}
