# Contributing to webhooks.cc

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** 20+ (with npm)
- **pnpm** 8+ (`npm install -g pnpm`)
- **Go** 1.25+
- **rustc** 1.93.0+
- **Make** (for running build commands)

You'll also need:

- A [Convex](https://convex.dev) account (free tier available)

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

   Edit `.env.local` and fill in your Convex credentials.

4. **Start the Convex backend** (in a separate terminal)

   ```bash
   pnpm dev:convex
   ```

5. **Start the Next.js web app**

   ```bash
   pnpm dev:web
   ```

6. **Start the Go receiver** (in a separate terminal)
   ```bash
   make dev-receiver
   ```

## Code Style

### TypeScript/JavaScript

- Run type checking before submitting: `pnpm typecheck`
- Format code with Prettier if configured
- Follow existing patterns in the codebase

### Go

- Run `go fmt` on all Go files
- Run `go vet` to catch common issues
- Follow standard Go conventions

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
   pnpm typecheck      # TypeScript type checking
   make test           # Run all tests
   make build          # Ensure everything builds
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
│   ├── receiver/     # Go webhook receiver
│   └── cli/          # Go CLI tool
├── packages/
│   └── sdk/          # TypeScript SDK
├── convex/           # Convex backend functions
└── docs/             # Documentation
```

## Getting Help

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Be respectful and constructive in discussions

## License

This project uses a split license. By contributing, you agree that your contributions will be licensed under the license that applies to the component you modify:

- **AGPL-3.0** for `apps/web/`, `apps/receiver/`, and `convex/`
- **MIT** for `apps/cli/`, `packages/sdk/`, and `apps/go-shared/`

See the root [LICENSE](LICENSE) and each component's `LICENSE` file for details.
