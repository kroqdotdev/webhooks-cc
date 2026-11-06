# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in webhooks.cc, report it privately. Do not open a public issue.

**Preferred:** use [GitHub's private vulnerability reporting](https://github.com/kroqdotdev/webhooks-cc/security/advisories/new). It keeps the conversation private while a fix is prepared.

**Alternatively:** email support@webhooks.cc with the subject line "Security Report".

Include:

- a description of the vulnerability,
- steps to reproduce it,
- the affected component (see Scope),
- the impact you have identified.

webhooks.cc is run by one developer. You will get an acknowledgement within 48 hours; critical issues are fixed as fast as possible, usually within 7 days.

## Scope

This policy covers:

- the hosted service: `webhooks.cc`, `go.webhooks.cc`, `mailhooks.cc` and its mail host `mx.mailhooks.cc`, and the remote MCP server at `webhooks.cc/mcp`,
- the code in this repository,
- what is published from it: the CLI (`whk`, GitHub Releases and the install script), the TypeScript SDK (`@webhooks-cc/sdk`), the Python SDK (`webhooks-cc` on PyPI), the Go SDK (`webhooks.cc/go`), the MCP server (`@webhooks-cc/mcp`), the Zapier and Make apps, and the Claude Code plugin.

## Out of scope

- Denial-of-service or volume attacks against the hosted service
- Spam or unsolicited mail sent to capture addresses
- Social engineering of the maintainer or of users
- Findings from automated scanners without a demonstrated impact
- Vulnerabilities in third-party dependencies (report them upstream, but tell us if they affect webhooks.cc)

Test only against your own account and endpoints, and never access other users' data.

## Disclosure

We follow coordinated disclosure. Once a fix ships, you are credited in the release notes unless you prefer otherwise.
