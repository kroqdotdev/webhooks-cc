// Package webhookscc is the webhooks.cc SDK for Go. It captures webhooks and
// email in your tests, waits for them, sends signed webhooks to your own
// handlers, and streams requests as they arrive.
//
//	client, err := webhookscc.New() // reads WHK_API_KEY
//	if err != nil {
//		return err
//	}
//	endpoint, err := client.Endpoints.Create(ctx, webhookscc.CreateEndpointOptions{Name: "checkout test"})
//	if err != nil {
//		return err
//	}
//	defer client.Endpoints.Delete(context.WithoutCancel(ctx), endpoint.Slug)
//
//	triggerCheckout(endpoint.URL)
//	request, err := client.Requests.WaitFor(ctx, endpoint.Slug, webhookscc.WaitOptions{
//		Timeout: 30 * time.Second,
//		Match:   webhookscc.MatchBodyPath("type", "checkout.session.completed"),
//	})
//
// Signature verification for 32 providers and for what webhooks.cc forwards
// is in the verify package, which has no dependency on the client; test
// helpers built on testing.TB are in whktest.
//
// An AI agent without an account uses NewSandbox: a few seconds of proof of
// work registers it (auth.md v0.6), and it may capture on up to 3 endpoints
// for 24 hours. Sandbox.Claim, or Connect, asks a human to connect the agent
// to their account; the connection is kept in the agent credential file the
// webhooks.cc MCP server, the whk CLI and the other SDKs share, where New and
// Connected find it when there is no API key. The agent package runs the
// registration steps one by one.
//
// The package passes the TypeScript SDK's conformance vectors for signing,
// verification and matchers, so it behaves like the other webhooks.cc SDKs.
package webhookscc

// Version is the SDK's version.
const Version = "0.3.0"
