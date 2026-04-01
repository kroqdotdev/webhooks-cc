# Contributing to webhooks.cc

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## Prerequisites

Before you begin, install the following:

- **Node.js** 20+ (with npm)
- **pnpm** 8+ (`npm install -g pnpm`)
- **Rust** 1.85+ (edition 2024) — install via [rustup](https://rustup.rs)
- **Make**

## Development Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/your-username/webhooks-cc.git
   cd webhooks-cc
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

3. **Set up environment variables**

   ```bash
   cp .env.example .env.local
   ```

   Fill in the shared Supabase and app settings in `.env.local`, including `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`, `SUPABASE_DB_URL`, `DATABASE_URL`, `NEXT_PUBLIC_WEBHOOK_URL`, `NEXT_PUBLIC_APP_URL`, and `CAPTURE_SHARED_SECRET`.

4. **Start the Next.js web app**

   ```bash
   pnpm dev:web
   ```

5. **Start the Rust receiver** (in a separate terminal)

   The receiver reads `DATABASE_URL` and `CAPTURE_SHARED_SECRET` from `.env.local`.

   ```bash
   make dev-receiver
   ```

## Code Style

### TypeScript/JavaScript

- Run type checking before submitting: `pnpm typecheck`
- Format code with Prettier if configured
- Follow existing patterns in the codebase

### Rust

- Run `cargo fmt` before submitting
- Run `cargo clippy` and fix all warnings
- Follow existing patterns in `apps/receiver-rs/`

## Making Changes

1. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write clear, focused commits
   - Include tests where appropriate
   - Update documentation if needed

3. **Test your changes**

   ```bash
   pnpm typecheck                        # TypeScript type checking
   make test                             # Run all tests (TS + Rust)
   make build                            # Build everything including binaries
   cd apps/receiver-rs && cargo clippy   # Lint Rust code
   cd apps/cli-rs && cargo clippy        # Lint Rust CLI
   ```

4. **Submit a pull request**
   - Use a clear, descriptive title
   - Describe what changes you made and why
   - Reference any related issues

## Commit Messages

Follow conventional commit format:

```
type(scope): description

[optional body]

[optional footer]
```

Types:

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code changes that neither fix bugs nor add features
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

Examples:

```
feat(endpoints): add custom response headers
fix(receiver): handle empty request bodies
docs(readme): update installation instructions
```

## Pull Request Process

1. Ensure your PR passes all checks (typecheck, tests, build)
2. Update documentation if you're changing behavior
3. Request review from maintainers
4. Address feedback and update your PR as needed
5. Once approved, a maintainer will merge your PR

## Project Structure

```
webhooks-cc/
├── apps/
│   ├── web/          # Next.js dashboard
│   ├── receiver-rs/  # Rust webhook receiver (Axum + Tokio + Postgres)
│   ├── cli-rs/       # Rust CLI with interactive TUI
├── packages/
│   ├── sdk/          # TypeScript SDK (@webhooks-cc/sdk)
│   └── mcp/          # MCP server for AI agents (@webhooks-cc/mcp)
├── supabase/         # Postgres schema, functions, and policies
└── .github/          # CI/CD workflows
```

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Be respectful and constructive in discussions

## License

This project uses a split license. By contributing, you agree that your contributions will be licensed under the license that applies to the component you modify:

- **AGPL-3.0** for `apps/web/`, `apps/receiver-rs/`, and `supabase/`
- **MIT** for `apps/cli-rs/`, `packages/sdk/`, and `packages/mcp/`

See the root [LICENSE](LICENSE) and each component's `LICENSE` file for details.
