package verify

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"webhooks.cc/go/internal/sigutil"
)

// PayPal signs transmission id|transmission time|webhook id|CRC-32 of the
// body with RSA-SHA256 and names the certificate holding its public key in
// paypal-cert-url. The certificate is trusted because of where it comes from,
// not by its chain or dates, so only PayPal's own certificate URLs are ever
// fetched, and only as rebuilt from what was checked.

const (
	paypalCertificatePath = "/v1/notifications/certs/"
	// PayPal rotates through very few live certificates; the URL path suffix
	// is sender-controlled, so the cache must be bounded.
	paypalCacheMax     = 16
	paypalFetchTimeout = 10 * time.Second
	paypalMaxRedirects = 5
	paypalMaxPEMBytes  = 1 << 20
)

var paypalHosts = map[string]bool{
	"api.paypal.com":           true,
	"api-m.paypal.com":         true,
	"api.sandbox.paypal.com":   true,
	"api-m.sandbox.paypal.com": true,
}

var (
	paypalCache   = map[string]string{}
	paypalCacheMu sync.Mutex

	// paypalTransport sends each request on its own: an http.Client would
	// read redirects itself, and each one must be checked first.
	paypalTransport http.RoundTripper = http.DefaultTransport
)

func paypal(ctx context.Context, body []byte, headers Headers, webhookID string, fetch func(context.Context, string) (string, error)) (bool, error) {
	transmissionID := header(headers, "paypal-transmission-id")
	transmissionTime := header(headers, "paypal-transmission-time")
	certURL := header(headers, "paypal-cert-url")
	authAlgo := header(headers, "paypal-auth-algo")
	signatureHeader := header(headers, "paypal-transmission-sig")
	if transmissionID == "" || transmissionTime == "" || certURL == "" || signatureHeader == "" {
		return false, nil
	}
	if authAlgo != "" && strings.ToUpper(authAlgo) != "SHA256WITHRSA" {
		return false, nil
	}
	certificateURL := canonicalPayPalCertificateURL(certURL)
	if certificateURL == nil {
		return false, nil
	}
	certificate, err := paypalCertificate(ctx, certificateURL, fetch)
	if err != nil {
		return false, err
	}
	publicKey := publicKeyFromPEM(certificate)
	if publicKey == nil {
		return false, nil
	}
	signature, err := sigutil.DecodeBase64(signatureHeader)
	if err != nil {
		return false, nil
	}
	digest := sha256.Sum256([]byte(paypalTransmissionMessage(body, transmissionID, transmissionTime, webhookID)))
	return rsa.VerifyPKCS1v15(publicKey, crypto.SHA256, digest[:], signature) == nil, nil
}

// paypalTransmissionMessage is what PayPal signs.
func paypalTransmissionMessage(body []byte, transmissionID, transmissionTime, webhookID string) string {
	return fmt.Sprintf("%s|%s|%s|%d", transmissionID, transmissionTime, webhookID, crc32.ChecksumIEEE(body))
}

// canonicalPayPalCertificateURL returns the URL to download a PayPal
// certificate from, or nil when it is not allowed: https on a PayPal API host
// with a path under /v1/notifications/certs/.
//
// The URL is read the way browsers (and the TypeScript SDK) read it, then
// rebuilt without user info, and only the rebuilt URL may be fetched. Go's
// URL parser does not read \ as /, so parsing the raw header could reach a
// host the check never saw.
func canonicalPayPalCertificateURL(raw string) *url.URL {
	cleaned := readLikeBrowser(raw)

	parsed, err := url.Parse(cleaned)
	if err != nil || parsed.Scheme != "https" || parsed.Opaque != "" {
		return nil
	}
	host := strings.ToLower(parsed.Hostname())
	if !paypalHosts[host] {
		return nil
	}
	hostPort := host
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number > 65535 {
			return nil
		}
		hostPort = host + ":" + strconv.Itoa(number)
	}
	path := parsed.EscapedPath()
	if path == "" {
		path = "/"
	}
	path = removeDotSegments(path)
	if !strings.HasPrefix(path, paypalCertificatePath) {
		return nil
	}
	canonical := "https://" + hostPort + path
	if parsed.RawQuery != "" {
		canonical += "?" + parsed.RawQuery
	}
	// Parse the rebuilt string once more and fetch exactly that.
	rebuilt, err := url.Parse(canonical)
	if err != nil || rebuilt.Scheme != "https" || rebuilt.Hostname() != host || rebuilt.User != nil ||
		!strings.HasPrefix(rebuilt.EscapedPath(), paypalCertificatePath) {
		return nil
	}
	return rebuilt
}

// readLikeBrowser prepares a URL the way browsers do before parsing it: tabs
// and newlines are dropped anywhere, C0 controls and spaces trimmed from the
// ends, and \ read as / before the query.
func readLikeBrowser(raw string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, raw)
	cleaned = strings.TrimFunc(cleaned, func(r rune) bool { return r <= 0x20 })
	if end := strings.IndexAny(cleaned, "?#"); end >= 0 {
		return strings.ReplaceAll(cleaned[:end], `\`, "/") + cleaned[end:]
	}
	return strings.ReplaceAll(cleaned, `\`, "/")
}

// removeDotSegments resolves . and .. segments, encoded ones included.
func removeDotSegments(path string) string {
	segments := strings.Split(path, "/")
	output := make([]string, 0, len(segments))
	for index, segment := range segments {
		lowered := strings.ToLower(segment)
		last := index == len(segments)-1
		switch lowered {
		case ".", "%2e":
			if last {
				output = append(output, "")
			}
			continue
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(output) > 1 {
				output = output[:len(output)-1]
			}
			if last {
				output = append(output, "")
			}
			continue
		}
		output = append(output, segment)
	}
	return strings.Join(output, "/")
}

func paypalCertificate(ctx context.Context, certificateURL *url.URL, fetch func(context.Context, string) (string, error)) (string, error) {
	key := certificateURL.String()
	// A custom fetcher owns its own transport and caching: sharing the
	// package cache across fetchers would let one fetcher's result leak into
	// another's.
	if fetch != nil {
		certificate, err := fetch(ctx, key)
		if err != nil {
			return "", fmt.Errorf("verify: unable to download the PayPal certificate from %s: %w", key, err)
		}
		return certificate, nil
	}

	paypalCacheMu.Lock()
	cached, ok := paypalCache[key]
	paypalCacheMu.Unlock()
	if ok {
		return cached, nil
	}

	certificate, err := downloadPayPalCertificate(ctx, certificateURL)
	if err != nil {
		return "", fmt.Errorf("verify: unable to download the PayPal certificate from %s: %w; set Options.FetchCertificate to supply it another way", key, err)
	}
	// Only parseable certificates enter the bounded cache: an error page must
	// not poison it, and the sender-controlled URL suffix must not grow it.
	if publicKeyFromPEM(certificate) != nil {
		paypalCacheMu.Lock()
		if len(paypalCache) < paypalCacheMax {
			paypalCache[key] = certificate
		}
		paypalCacheMu.Unlock()
	}
	return certificate, nil
}

func downloadPayPalCertificate(ctx context.Context, target *url.URL) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, paypalFetchTimeout)
	defer cancel()
	for range paypalMaxRedirects + 1 {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return "", err
		}
		// The URL was checked as parsed; send that one, not a reparse.
		request.URL, request.Host = target, target.Host
		response, err := paypalTransport.RoundTrip(request)
		if err != nil {
			return "", err
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, paypalMaxPEMBytes))
		response.Body.Close()
		location := response.Header.Get("Location")
		if response.StatusCode >= 300 && response.StatusCode < 400 && location != "" {
			// Follow PayPal's own redirects only.
			next := resolvePayPalRedirect(target, location)
			if next == nil {
				return "", fmt.Errorf("redirected outside PayPal's certificate URLs to %s", location)
			}
			target = next
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return "", fmt.Errorf("HTTP %d", response.StatusCode)
		}
		if readErr != nil {
			return "", readErr
		}
		return string(data), nil
	}
	return "", errors.New("too many redirects")
}

// resolvePayPalRedirect resolves a Location against the URL that answered,
// reading it the way a browser would, and returns the canonical URL to
// fetch next, or nil when it leaves PayPal's certificate URLs.
func resolvePayPalRedirect(base *url.URL, location string) *url.URL {
	cleaned := readLikeBrowser(location)
	reference, err := url.Parse(cleaned)
	if err != nil {
		return nil
	}
	return canonicalPayPalCertificateURL(base.ResolveReference(reference).String())
}

var (
	pemPublicKey   = regexp.MustCompile(`(?i)-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----`)
	pemCertificate = regexp.MustCompile(`(?i)-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----`)
)

func pemToDER(pem string, pattern *regexp.Regexp) []byte {
	match := pattern.FindStringSubmatch(pem)
	if match == nil {
		return nil
	}
	der, err := sigutil.DecodeBase64(strings.Join(strings.Fields(match[1]), ""))
	if err != nil || len(der) == 0 {
		return nil
	}
	return der
}

// publicKeyFromPEM reads the RSA public key of a PEM public key or
// certificate. A certificate's chain and dates are not checked, and its
// SubjectPublicKeyInfo is read directly, so certificates crypto/x509 would
// refuse still work, as in the other SDKs.
func publicKeyFromPEM(pem string) *rsa.PublicKey {
	spki := pemToDER(pem, pemPublicKey)
	if spki == nil {
		certificate := pemToDER(pem, pemCertificate)
		if certificate == nil {
			return nil
		}
		spki = subjectPublicKeyInfo(certificate)
		if spki == nil {
			return nil
		}
	}
	key, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		return nil
	}
	rsaKey, _ := key.(*rsa.PublicKey)
	return rsaKey
}

// derElement is one DER tag-length-value: its tag, where it starts, where its
// value starts and where it ends.
type derElement struct{ tag, start, valueStart, end int }

func readDER(data []byte, offset int) (derElement, bool) {
	if offset+1 >= len(data) {
		return derElement{}, false
	}
	element := derElement{tag: int(data[offset]), start: offset}
	offset++
	length := int(data[offset])
	offset++
	if length&0x80 != 0 {
		count := length & 0x7F
		if count == 0 || count > 4 || offset+count > len(data) {
			return derElement{}, false
		}
		length = 0
		for _, b := range data[offset : offset+count] {
			length = length<<8 | int(b)
		}
		offset += count
	}
	element.valueStart = offset
	element.end = offset + length
	if length < 0 || element.end > len(data) {
		return derElement{}, false
	}
	return element, true
}

// subjectPublicKeyInfo returns the SubjectPublicKeyInfo of an X.509
// certificate without checking anything else about it.
func subjectPublicKeyInfo(der []byte) []byte {
	certificate, ok := readDER(der, 0)
	if !ok || certificate.tag != 0x30 {
		return nil
	}
	tbs, ok := readDER(der, certificate.valueStart)
	if !ok || tbs.tag != 0x30 {
		return nil
	}
	cursor := tbs.valueStart
	first, ok := readDER(der, cursor)
	if !ok {
		return nil
	}
	if first.tag == 0xA0 { // explicit version
		cursor = first.end
	}
	// serialNumber, signature, issuer, validity, subject
	for range 5 {
		part, ok := readDER(der, cursor)
		if !ok {
			return nil
		}
		cursor = part.end
	}
	spki, ok := readDER(der, cursor)
	if !ok || spki.tag != 0x30 {
		return nil
	}
	return der[spki.start:spki.end]
}
