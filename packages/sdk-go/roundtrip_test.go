package webhookscc_test

import (
	"slices"
	"testing"
	"time"

	webhookscc "webhooks.cc/go"
	"webhooks.cc/go/verify"
)

// What the SDK signs, the SDK verifies: every template of every verifiable provider.
func TestSignedTemplatesVerify(t *testing.T) {
	const target = "https://example.com/hooks/acme?source=roundtrip"
	secretFor := func(provider string) string {
		switch provider {
		case "adyen":
			return "44782DEF547AAA06C910C43932B1EB0C71FC68D9D0C057550C48EC2ACF6BA056"
		case "standard-webhooks", "clerk", "resend":
			return "whsec_cm91bmR0cmlwLXNlY3JldA=="
		}
		return "roundtrip_secret"
	}
	cases := 0
	for _, provider := range verify.Providers() {
		// Discord and PayPal sign with private keys a test does not hold.
		if provider == "discord" || provider == "paypal" {
			continue
		}
		info, ok := webhookscc.TemplateProvider(provider)
		if !ok {
			t.Errorf("%s verifies but has no templates", provider)
			continue
		}
		templates := info.Templates
		if len(templates) == 0 {
			templates = []string{""}
		}
		for _, template := range templates {
			cases++
			t.Run(provider+"/"+template, func(t *testing.T) {
				secret := secretFor(provider)
				built, err := webhookscc.BuildRequest(target, webhookscc.SendOptions{Provider: provider, Secret: secret, Template: template})
				if err != nil {
					t.Fatal(err)
				}
				opts := verify.Options{Secret: secret, URL: target, Method: built.Method, Now: time.Now()}
				valid, err := verify.Signature(provider, built.Body, verify.Map(built.Headers), opts)
				if err != nil || !valid {
					t.Errorf("valid = %v, %v", valid, err)
				}
				opts.Secret += "x"
				if valid, err := verify.Signature(provider, built.Body, verify.Map(built.Headers), opts); err != nil || valid {
					t.Errorf("with the wrong secret: valid = %v, %v", valid, err)
				}
			})
		}
	}
	if cases < 60 {
		t.Errorf("only %d cases", cases)
	}
	if !slices.Contains(webhookscc.TemplateProviders(), "sendgrid") {
		t.Error("sendgrid templates are missing")
	}
}
