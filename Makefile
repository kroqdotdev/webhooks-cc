.PHONY: dev dev-all dev-web dev-convex dev-receiver dev-receiver-go dev-cli build build-receiver build-receiver-go build-cli test lint clean db-push prod prod-web prod-receiver

# Development
dev:
	@echo "Starting development servers..."
	@make -j3 dev-web dev-convex dev-receiver

dev-web:
	pnpm --filter web dev

dev-convex:
	pnpm convex dev

dev-receiver:
	@set -a && . ./.env.local && set +a && cd apps/receiver-rs && cargo run

dev-receiver-go:
	@set -a && . ./.env.local && set +a && cd apps/receiver && go run .

dev-cli:
	cd apps/cli && go run ./cmd/whk $(ARGS)

# Production
prod:
	@echo "Deploying Convex and building..."
	npx convex deploy
	pnpm build
	cd apps/receiver-rs && cargo build --release && cp target/release/webhooks-receiver ../../dist/receiver
	@echo "Starting production servers..."
	@make -j2 prod-web prod-receiver

prod-web:
	pnpm --filter web start

prod-receiver:
	@set -a && . ./.env.local && set +a && ./dist/receiver

# Build
build:
	pnpm build
	cd apps/receiver-rs && cargo build --release && cp target/release/webhooks-receiver ../../dist/receiver
	cd apps/cli && go build -o ../../dist/whk ./cmd/whk

build-receiver:
	cd apps/receiver-rs && cargo build --release && cp target/release/webhooks-receiver ../../dist/receiver

build-receiver-go:
	cd apps/receiver && go build -o ../../dist/receiver-go .

build-cli:
	cd apps/cli && goreleaser build --snapshot --clean

# Test
test:
	pnpm test
	pnpm test:convex
	cd apps/receiver-rs && cargo test
	cd apps/receiver && go test ./...
	cd apps/cli && go test ./...

# Lint
lint:
	cd apps/receiver-rs && cargo clippy -- -D warnings
	cd apps/receiver && golangci-lint run
	cd apps/cli && golangci-lint run

# Database
db-push:
	pnpm convex deploy

# Clean
clean:
	rm -rf dist
	rm -rf apps/web/.next
	rm -rf node_modules
	rm -rf apps/web/node_modules
	rm -rf packages/sdk/node_modules
	rm -rf apps/receiver-rs/target
