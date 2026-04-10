# Security Policy

## Reporting a Vulnerability

If you find a security vulnerability in webhooks.cc, please report it privately. Do not open a public issue.

**Preferred:** Use [GitHub's security advisory reporting](https://github.com/kroqdotdev/webhooks-cc/security/advisories/new) to submit your report directly through GitHub. This keeps the conversation private and lets us coordinate a fix before public disclosure.

**Alternatively:** Email support@webhooks.cc with the subject line "Security Report."

Include:

- A description of the vulnerability
- Steps to reproduce it
- The affected component (web app, receiver, CLI, SDK, or MCP server)
- Any potential impact you've identified

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

This policy covers:

- The hosted service at webhooks.cc and go.webhooks.cc
- The open source code in this repository
- The CLI (`whk`), SDK (`@webhooks-cc/sdk`), and MCP server (`@webhooks-cc/mcp`) published to npm and GitHub Releases

## Out of Scope

- Denial-of-service attacks against the hosted service
- Social engineering of maintainers or users
- Vulnerabilities in third-party dependencies (report these upstream, but let us know if they affect webhooks.cc)

## Disclosure

We follow coordinated disclosure. Once a fix ships, we will credit you in the release notes unless you prefer otherwise.
