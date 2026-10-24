package verify

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// These tests replace the package's HTTP client and cache, so none of them
// runs in parallel.

func TestPayPalCertificateURLs(t *testing.T) {
	cases := []struct {
		url     string
		allowed bool
	}{
		{"https://api.paypal.com/v1/notifications/certs/CERT-360caa42", true},
		{"https://API-M.PayPal.com:443/v1/notifications/certs/x", true},
		{"https://api.sandbox.paypal.com/v1/notifications/certs/x", true},
		{"https://api-m.sandbox.paypal.com/v1/notifications/certs/x?a=1#frag", true},
		{"http://api.paypal.com/v1/notifications/certs/x", false},
		{"https://api.paypal.com.evil.test/v1/notifications/certs/x", false},
		{"https://api.paypal.com@evil.test/v1/notifications/certs/x", false},
		{"https://api.paypal.com/v1/notifications/certs/../../oauth2/token", false},
		{"https://api.paypal.com/v1/notifications/certs/%2e%2e/x", false},
		{"https://api.paypal.com/v1/notifications/certs/.%2E/x", false},
		{`https://api.paypal.com\@evil.test/v1/notifications/certs/x`, false},
		{"https://api.paypal.com:99999/v1/notifications/certs/x", false},
		{"https://api.paypal.com:x/v1/notifications/certs/x", false},
		{"https://api.paypal.com/v1/other", false},
		{"https:api.paypal.com/v1/notifications/certs/x", false},
		{"not a url", false},
		{"", false},
	}
	for _, c := range cases {
		if got := canonicalPayPalCertificateURL(c.url) != nil; got != c.allowed {
			t.Errorf("%q: allowed = %v, want %v", c.url, got, c.allowed)
		}
	}
}

func TestPayPalCertificateURLsAreRebuilt(t *testing.T) {
	cases := map[string]string{
		`https://api.paypal.com\v1\notifications\certs\x@evil.test/`: "https://api.paypal.com/v1/notifications/certs/x@evil.test/",
		"https://user:pw@api.paypal.com/v1/notifications/certs/x":    "https://api.paypal.com/v1/notifications/certs/x",
		"\thttps://api.paypal.com/v1/noti\nfications/certs/x\n ":     "https://api.paypal.com/v1/notifications/certs/x",
		"https://API.paypal.com:0443/v1/notifications/certs/./x#f":   "https://api.paypal.com:443/v1/notifications/certs/x",
		`https://api.paypal.com/v1/notifications/certs/x?q=a\b`:      `https://api.paypal.com/v1/notifications/certs/x?q=a\b`,
	}
	for input, want := range cases {
		got := canonicalPayPalCertificateURL(input)
		if got == nil || got.String() != want || got.Hostname() != strings.ToLower(got.Hostname()) {
			t.Errorf("%q: got %v, want %s", input, got, want)
		}
	}
}

// fakePayPal answers certificate downloads in place of the network.
type fakePayPal struct {
	mu      sync.Mutex
	fetched []string
	respond func(n int, request *http.Request) *http.Response
}

func (f *fakePayPal) RoundTrip(request *http.Request) (*http.Response, error) {
	f.mu.Lock()
	f.fetched = append(f.fetched, request.URL.String())
	n := len(f.fetched)
	f.mu.Unlock()
	response := f.respond(n, request)
	if response == nil {
		return nil, errors.New("connection refused")
	}
	response.Request = request
	return response, nil
}

func textResponse(status int, location, body string) *http.Response {
	header := http.Header{}
	if location != "" {
		header.Set("Location", location)
	}
	return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body))}
}

// usePayPalTransport routes certificate downloads through transport and
// empties the cache for the test.
func usePayPalTransport(t *testing.T, transport http.RoundTripper) {
	t.Helper()
	previous, cache := paypalTransport, paypalCache
	paypalTransport, paypalCache = transport, map[string]string{}
	t.Cleanup(func() { paypalTransport, paypalCache = previous, cache })
}

func paypalWithHeaders(t *testing.T, override map[string]string) (bool, error) {
	t.Helper()
	vector := verifyVectorNamed(t, "paypal")
	headers := Map{}
	for key, value := range vector.Headers {
		headers[key] = value
	}
	for key, value := range override {
		headers[key] = value
	}
	return Signature("paypal", []byte(vector.Body), headers, Options{Secret: vector.Secret})
}

func TestPayPalDownloadsAndCachesTheCertificate(t *testing.T) {
	certificate := verifyVectorNamed(t, "paypal").Certificate
	fake := &fakePayPal{respond: func(int, *http.Request) *http.Response { return textResponse(200, "", certificate) }}
	usePayPalTransport(t, fake)
	for range 2 {
		if valid, err := paypalWithHeaders(t, nil); !valid || err != nil {
			t.Fatalf("Signature = %v, %v", valid, err)
		}
	}
	if len(fake.fetched) != 1 {
		t.Errorf("fetched %d times, want once: %v", len(fake.fetched), fake.fetched)
	}
}

func TestPayPalDoesNotCacheWhatIsNotACertificate(t *testing.T) {
	fake := &fakePayPal{respond: func(int, *http.Request) *http.Response { return textResponse(200, "", "<html>maintenance</html>") }}
	usePayPalTransport(t, fake)
	for range 2 {
		if valid, err := paypalWithHeaders(t, nil); valid || err != nil {
			t.Fatalf("Signature = %v, %v", valid, err)
		}
	}
	if len(fake.fetched) != 2 {
		t.Errorf("fetched %d times, want twice", len(fake.fetched))
	}
}

func TestPayPalFollowsOnlyPayPalRedirects(t *testing.T) {
	fake := &fakePayPal{respond: func(int, *http.Request) *http.Response {
		return textResponse(302, "https://evil.test/cert.pem", "")
	}}
	usePayPalTransport(t, fake)
	valid, err := paypalWithHeaders(t, nil)
	if valid || err == nil || !strings.Contains(err.Error(), "redirected outside PayPal") {
		t.Fatalf("Signature = %v, %v", valid, err)
	}
	if len(fake.fetched) != 1 {
		t.Errorf("fetched %v", fake.fetched)
	}
}

func TestPayPalDownloadsOnlyFromTheURLItChecked(t *testing.T) {
	certificate := verifyVectorNamed(t, "paypal").Certificate
	for _, certURL := range []string{
		// Read as api.paypal.com (\ is /, as in browsers); a parser that does
		// not read it that way sees evil.test as the host.
		`https://api.paypal.com\v1\notifications\certs\x@evil.test/`,
		"https://user@api.paypal.com/v1/notifications/certs/x",
		"\thttps://api.paypal.com/v1/notifications/certs/x\n",
	} {
		fake := &fakePayPal{respond: func(int, *http.Request) *http.Response { return textResponse(200, "", certificate) }}
		usePayPalTransport(t, fake)
		if _, err := paypalWithHeaders(t, map[string]string{"paypal-cert-url": certURL}); err != nil {
			t.Fatalf("%q: %v", certURL, err)
		}
		if len(fake.fetched) != 1 {
			t.Fatalf("%q: fetched %v", certURL, fake.fetched)
		}
		host := strings.SplitN(strings.TrimPrefix(fake.fetched[0], "https://"), "/", 2)[0]
		if host != "api.paypal.com" {
			t.Errorf("%q: fetched %s", certURL, fake.fetched[0])
		}
	}
}

func TestPayPalRedirectsAreRebuiltToo(t *testing.T) {
	certificate := verifyVectorNamed(t, "paypal").Certificate
	fake := &fakePayPal{respond: func(n int, _ *http.Request) *http.Response {
		switch n {
		case 1:
			return textResponse(302, `https://api.paypal.com\v1\notifications\certs\y@evil.test/`, "")
		case 2:
			return textResponse(301, "../z", "")
		}
		return textResponse(200, "", certificate)
	}}
	usePayPalTransport(t, fake)
	if valid, err := paypalWithHeaders(t, nil); !valid || err != nil {
		t.Fatalf("Signature = %v, %v", valid, err)
	}
	want := []string{
		"https://api.paypal.com/v1/notifications/certs/y@evil.test/",
		"https://api.paypal.com/v1/notifications/certs/z",
	}
	if len(fake.fetched) != 3 || fake.fetched[1] != want[0] || fake.fetched[2] != want[1] {
		t.Errorf("fetched %v, want the original then %v", fake.fetched, want)
	}
}

func TestPayPalStopsAfterFiveRedirects(t *testing.T) {
	fake := &fakePayPal{respond: func(n int, _ *http.Request) *http.Response {
		return textResponse(302, "/v1/notifications/certs/again", "")
	}}
	usePayPalTransport(t, fake)
	_, err := paypalWithHeaders(t, nil)
	if err == nil || !strings.Contains(err.Error(), "too many redirects") || len(fake.fetched) != 6 {
		t.Errorf("err = %v after %d fetches", err, len(fake.fetched))
	}
}

func TestPayPalDownloadFailuresAreNotAVerdict(t *testing.T) {
	usePayPalTransport(t, &fakePayPal{respond: func(int, *http.Request) *http.Response { return nil }})
	if valid, err := paypalWithHeaders(t, nil); valid || err == nil || !strings.Contains(err.Error(), "unable to download the PayPal certificate") {
		t.Errorf("transport error: Signature = %v, %v", valid, err)
	}
	usePayPalTransport(t, &fakePayPal{respond: func(int, *http.Request) *http.Response { return textResponse(503, "", "") }})
	if valid, err := paypalWithHeaders(t, nil); valid || err == nil || !strings.Contains(err.Error(), "HTTP 503") {
		t.Errorf("503: Signature = %v, %v", valid, err)
	}

	vector := verifyVectorNamed(t, "paypal")
	broken := func(context.Context, string) (string, error) { return "", errors.New("connection refused") }
	valid, err := Signature("paypal", []byte(vector.Body), Map(vector.Headers), Options{Secret: vector.Secret, FetchCertificate: broken})
	if valid || err == nil || !strings.Contains(err.Error(), "unable to download the PayPal certificate") || !strings.Contains(err.Error(), "connection refused") {
		t.Errorf("fetcher error: Signature = %v, %v", valid, err)
	}
}

func TestPayPalFetcherGetsTheCanonicalURL(t *testing.T) {
	vector := verifyVectorNamed(t, "paypal")
	headers := Map{}
	for key, value := range vector.Headers {
		headers[key] = value
	}
	headers["paypal-cert-url"] = `https://user@API.paypal.com\v1\notifications\certs\x`
	var got string
	fetch := func(_ context.Context, url string) (string, error) { got = url; return vector.Certificate, nil }
	if _, err := Signature("paypal", []byte(vector.Body), headers, Options{Secret: vector.Secret, FetchCertificate: fetch}); err != nil {
		t.Fatal(err)
	}
	if got != "https://api.paypal.com/v1/notifications/certs/x" {
		t.Errorf("fetcher got %q", got)
	}
}

// A real HTTP exchange: the client must not follow redirects on its own, and
// must send the URL it checked.
func TestPayPalDownloadOverHTTP(t *testing.T) {
	certificate := verifyVectorNamed(t, "paypal").Certificate
	var mu sync.Mutex
	var paths []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.Host+r.URL.RequestURI())
		mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/old") {
			http.Redirect(w, r, "/v1/notifications/certs/new", http.StatusFound)
			return
		}
		io.WriteString(w, certificate)
	}))
	defer server.Close()
	address := server.Listener.Addr().String()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport := &http.Transport{
		// Every host resolves to the test server, whose certificate is for
		// example.com: verify it as that.
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, address)
		},
		TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "example.com"},
	}
	defer transport.CloseIdleConnections()
	usePayPalTransport(t, transport)

	valid, err := paypalWithHeaders(t, map[string]string{"paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/old"})
	if !valid || err != nil {
		t.Fatalf("Signature = %v, %v", valid, err)
	}
	want := []string{"api.paypal.com/v1/notifications/certs/old", "api.paypal.com/v1/notifications/certs/new"}
	if strings.Join(paths, " ") != strings.Join(want, " ") {
		t.Errorf("requests %v, want %v", paths, want)
	}
}

func TestPayPalTransmissionMessage(t *testing.T) {
	if got := paypalTransmissionMessage(nil, "id", "time", "hook"); got != "id|time|hook|0" {
		t.Errorf("got %q", got)
	}
	// The CRC-32 of "hello" is 0x3610A686.
	if got := paypalTransmissionMessage([]byte("hello"), "i", "t", "w"); got != "i|t|w|907060870" {
		t.Errorf("got %q", got)
	}
}

func TestPayPalRefusesOtherAlgorithmsAndKeys(t *testing.T) {
	vector := verifyVectorNamed(t, "paypal")
	fetch := func(context.Context, string) (string, error) { return vector.Certificate, nil }
	headers := Map{}
	for key, value := range vector.Headers {
		headers[key] = value
	}
	headers["paypal-auth-algo"] = "SHA256withECDSA"
	if valid, err := Signature("paypal", []byte(vector.Body), headers, Options{Secret: vector.Secret, FetchCertificate: fetch}); valid || err != nil {
		t.Errorf("another algorithm: %v, %v", valid, err)
	}
	headers["paypal-auth-algo"] = "sha256WITHrsa"
	if valid, err := Signature("paypal", []byte(vector.Body), headers, Options{Secret: vector.Secret, FetchCertificate: fetch}); !valid || err != nil {
		t.Errorf("the algorithm in another case: %v, %v", valid, err)
	}
	garbage := func(context.Context, string) (string, error) {
		return "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----", nil
	}
	if valid, err := Signature("paypal", []byte(vector.Body), Map(vector.Headers), Options{Secret: vector.Secret, FetchCertificate: garbage}); valid || err != nil {
		t.Errorf("an unreadable certificate: %v, %v", valid, err)
	}
}
