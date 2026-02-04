import type { Metadata } from "next";


export const metadata: Metadata = {
  title: "Mock Responses - webhooks.cc Docs",
  description: "Configure what your webhook endpoint returns: status codes, headers, and body.",
};

export default function MockResponsesPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Mock Responses</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Control what your endpoint returns to the sender. Set status codes, response headers, and body content
        to simulate real API behavior.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">How it works</h2>
        <p className="text-muted-foreground mb-4">
          By default, endpoints return <code className="font-mono font-bold">200 OK</code> with an empty body.
          Configure a mock response to change this behavior.
        </p>
        <p className="text-muted-foreground">
          When a webhook hits your endpoint, the receiver captures the request and returns your configured
          response. The sender sees your custom status code, headers, and body.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Configuration</h2>
        <p className="text-muted-foreground mb-4">
          Open endpoint settings (gear icon in the URL bar) to configure the mock response:
        </p>
        <ul className="list-disc list-inside space-y-2 text-muted-foreground mb-4">
          <li>
            <strong className="text-foreground">Status code</strong> - any valid HTTP status (100-599).
            Common choices: 200, 201, 204, 400, 404, 500.
          </li>
          <li>
            <strong className="text-foreground">Response headers</strong> - key-value pairs sent back to the caller.
            Example: <code className="font-mono">Content-Type: application/json</code>
          </li>
          <li>
            <strong className="text-foreground">Response body</strong> - the content returned. Can be JSON, XML,
            plain text, or any other format.
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Use cases</h2>
        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
          <li>
            <strong className="text-foreground">Simulate success</strong> - return 200 with a JSON body to satisfy
            webhook senders that expect confirmation
          </li>
          <li>
            <strong className="text-foreground">Test error handling</strong> - return 500 or 503 to verify your
            sender retries on failure
          </li>
          <li>
            <strong className="text-foreground">Validate signatures</strong> - return the expected response format
            for services like Stripe that check the response
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Example</h2>
        <p className="text-muted-foreground mb-4">
          To simulate a Stripe-compatible webhook endpoint:
        </p>
        <div className="neo-code text-sm space-y-2">
          <div><strong>Status:</strong> 200</div>
          <div><strong>Headers:</strong></div>
          <div className="pl-4">Content-Type: application/json</div>
          <div><strong>Body:</strong></div>
          <pre className="pl-4">{`{"received": true}`}</pre>
        </div>
      </section>
    </article>
  );
}
