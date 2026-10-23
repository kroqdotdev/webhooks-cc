// Package verify checks webhook signatures: those of 32 providers, and the
// signatures webhooks.cc puts on what it forwards.
//
// It is a port of the TypeScript SDK's verification, and both pass the same
// conformance tests. Pass the body as the exact bytes you received, before
// any JSON parsing; header names match in any case.
//
//	func handleStripe(w http.ResponseWriter, r *http.Request) {
//		body, err := io.ReadAll(r.Body)
//		if err != nil {
//			http.Error(w, "bad request", http.StatusBadRequest)
//			return
//		}
//		ok, err := verify.Signature("stripe", body, r.Header, verify.Options{Secret: secret})
//		if err != nil || !ok {
//			http.Error(w, "invalid signature", http.StatusUnauthorized)
//			return
//		}
//		// handle the event
//	}
//
// What webhooks.cc forwards is checked with the endpoint's forwarding
// secret:
//
//	event, err := verify.ForwardedEmail(body, r.Header, secret)
//	if err != nil {
//		status := http.StatusUnauthorized
//		var verr *verify.Error
//		if errors.As(err, &verr) && verr.Code == verify.CodeInvalidPayload {
//			status = http.StatusBadRequest
//		}
//		http.Error(w, "invalid delivery", status)
//		return
//	}
//
// A *Error says why a delivery was refused; any other error means the call
// itself was wrong, such as an empty secret.
package verify
