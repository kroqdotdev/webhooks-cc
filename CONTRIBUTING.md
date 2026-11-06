# Contributing to webhooks.cc

webhooks.cc is open source so that anyone can inspect the code behind a service that holds their webhooks and email. It is built and run by one developer, and most changes are made in-house. This page explains how to take part anyway.

## Reporting a bug

Open an issue with the [bug report form](https://github.com/kroqdotdev/webhooks-cc/issues/new?template=bug_report.yml). Say which part is affected (dashboard, capture, email, CLI, an SDK, the MCP server), what you did, what you expected and what happened instead. Version numbers help for the CLI, the SDKs and the MCP server.

The repository is public. Never paste API keys, signing secrets, captured request bodies, email contents, or endpoint URLs and slugs into an issue. Describe them, or replace them with made-up values.

## Asking for a feature

Open an issue with the [feature request form](https://github.com/kroqdotdev/webhooks-cc/issues/new?template=feature_request.yml). Describe the problem you run into before the solution you have in mind: the problem is what gets weighed.

## Account, billing and data questions

These go to [webhooks.cc/support](https://webhooks.cc/support) (signed in) or support@webhooks.cc, never to a public issue. They need details about your account that do not belong in a public repository.

## Security vulnerabilities

Report them privately, as described in [SECURITY.md](SECURITY.md). Do not open a public issue.

## Pull requests

Pull requests are accepted only from people who have signed the [Contributor License Agreement](CLA.md). The CLA lets the project keep its licensing options open (including offering the code under other terms) while you keep the copyright in your work. When you open a pull request, the CLA check asks you to sign by posting a comment; you sign once for all future contributions.

Before you write code, open an issue and wait for an answer. Changes that were not discussed are usually closed, and an accepted idea may be implemented in-house rather than merged as submitted. Small, obviously correct fixes (a typo, a broken link) can skip the issue.

A pull request should:

- do one thing, with a clear description of what and why,
- pass CI (lint, typecheck, build, the unit suites and the Rust jobs),
- come with tests where behaviour changes,
- follow the conventions in [AGENTS.md](AGENTS.md), which also lists the commands to build and test every part.

Commit messages follow the conventional commit format (`feat(sdk): ...`, `fix(receiver): ...`, `docs: ...`). Pull requests are squash merged.

## Building from source

[AGENTS.md](AGENTS.md) describes the layout, the commands for each component and the local stack (a self-hosted Supabase instance, the Rust receiver and the web app). `.env.example` lists the required environment variables.

## License

By contributing you agree to the terms of the [CLA](CLA.md). Your contribution is published under the license of the component you change:

- **AGPL-3.0** for `apps/web/`, `apps/receiver-rs/`, `apps/mx-rs/`, `apps/parser-rs/` and `supabase/`
- **MIT** for `apps/cli-rs/`, `packages/sdk/`, `packages/sdk-python/`, `packages/sdk-go/`, `packages/mcp/`, `packages/zapier-app/`, `packages/make-app/` and `plugins/`

See the root [LICENSE](LICENSE) and each component's `LICENSE` file.
