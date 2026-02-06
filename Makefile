.PHONY: dev dev-all dev-web dev-convex dev-receiver dev-cli build build-receiver build-cli test lint clean db-push

# Development
dev:
	@echo "Starting development servers..."
	@make -j3 dev-web dev-convex dev-receiver

dev-web:
	pnpm --filter web dev

dev-convex:
	pnpm convex dev

dev-receiver:
	@set -a && . ./.env.local && set +a && cd apps/receiver && go run .

dev-cli:
	cd apps/cli && go run ./cmd/whk $(ARGS)

# Build
build:
	pnpm build
	cd apps/receiver && go build -o ../../dist/receiver .
	cd apps/cli && go build -o ../../dist/whk ./cmd/whk

build-receiver:
	cd apps/receiver && go build -o ../../dist/receiver .

build-cli:
	cd apps/cli && goreleaser build --snapshot --clean

# Test
test:
	pnpm test
	cd apps/receiver && go test ./...
	cd apps/cli && go test ./...

# Lint
lint:
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
