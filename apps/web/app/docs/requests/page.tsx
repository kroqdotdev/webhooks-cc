import { createPageMetadata } from "@/lib/seo";

export const metadata = createPageMetadata({
  title: "Requests Docs",
  description: "Inspect captured webhook requests: body, headers, query parameters, and more.",
  path: "/docs/requests",
});

export default function RequestsPage() {
  return (
    <article>
      <h1 className="text-3xl md:text-4xl font-bold mb-4">Requests</h1>
      <p className="text-lg text-muted-foreground mb-10">
        Every webhook sent to your endpoint is captured and displayed in real-time. Inspect every
        detail of the incoming request.
      </p>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Request list</h2>
        <p className="text-muted-foreground mb-4">
          The left panel shows captured requests sorted by time. Each entry displays the HTTP
          method, a short ID, and relative timestamp.
        </p>
        <ul className="list-disc list-inside space-y-1 text-muted-foreground">
          <li>
            <strong className="text-foreground">Live mode</strong> - new requests are auto-selected
            as they arrive
          </li>
          <li>
            <strong className="text-foreground">Paused mode</strong> - review at your pace; a banner
            shows how many new requests arrived
          </li>
          <li>
            <strong className="text-foreground">Sort</strong> - toggle between newest-first and
            oldest-first
          </li>
          <li>
            <strong className="text-foreground">Filter</strong> - filter by HTTP method or search by
            path, body, or request ID
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Request detail</h2>
        <p className="text-muted-foreground mb-4">
          Click a request to view its details. Four tabs organize the data:
        </p>
        <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
          <li>
            <strong className="text-foreground">Body</strong> - auto-formatted based on content type
            (JSON, XML, form data, plain text)
          </li>
          <li>
            <strong className="text-foreground">Headers</strong> - all request headers in a
            key-value table
          </li>
          <li>
            <strong className="text-foreground">Query</strong> - parsed query string parameters
          </li>
          <li>
            <strong className="text-foreground">Raw</strong> - unformatted request body
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          A format badge (JSON, XML, FORM, TEXT) appears above the body for quick identification.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Copy as curl</h2>
        <p className="text-muted-foreground">
          Click the <strong className="text-foreground">cURL</strong> button to copy a curl command
          that reproduces the captured request. Headers, method, body, and query parameters are
          preserved. Use this to replay the request from your terminal.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Replay</h2>
        <p className="text-muted-foreground">
          Click <strong className="text-foreground">Replay</strong> to send the captured request to
          a different URL. Enter a destination URL (http or https), and the request is sent with the
          original method, headers, and body. Useful for testing your local or staging server.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-bold mb-3">Export</h2>
        <p className="text-muted-foreground">
          Use the <strong className="text-foreground">Export</strong> dropdown in the URL bar to
          download requests as JSON or CSV. Exports include the currently visible (filtered)
          requests.
        </p>
      </section>
    </article>
  );
}
