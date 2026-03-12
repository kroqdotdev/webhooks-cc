.PHONY: dev dev-all dev-web dev-convex dev-receiver dev-cli build build-receiver build-cli test lint clean db-push prod prod-web prod-receiver start

# Development
dev:
	@echo "Starting development servers..."
	@make -j3 dev-web dev-convex dev-receiver

dev-web:
	pnpm --filter web dev

dev-convex:
	pnpm convex dev

dev-receiver:
	@set -a && . ./.env.local && set +a && cd apps/receiver-rs && $$HOME/.cargo/bin/cargo run

dev-cli:
	cd apps/cli && go run ./cmd/whk $(ARGS)

# Production (systemd services + mprocs log viewer)
prod:
	@echo "Ensuring services are running..."
	@systemctl --user start webhooks-web webhooks-receiver
	@echo "Opening log viewer (mprocs)..."
	$$HOME/.cargo/bin/mprocs --config mprocs.yaml

prod-status:
	@systemctl --user status webhooks-web webhooks-receiver

prod-stop:
	@systemctl --user stop webhooks-web webhooks-receiver

prod-restart:
	@systemctl --user restart webhooks-web webhooks-receiver

# Build
build:
	pnpm build
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo build --release && cp target/release/webhooks-receiver ../../dist/receiver
	cd apps/cli && go build -o ../../dist/whk ./cmd/whk

build-receiver:
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo build --release && cp target/release/webhooks-receiver ../../dist/receiver

# Deploy (build + restart)
deploy-receiver:
	@echo "Building receiver..."
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo build --release
	@echo "Stopping receiver (draining requests)..."
	-@systemctl --user stop webhooks-receiver
	@cp apps/receiver-rs/target/release/webhooks-receiver dist/receiver
	@echo "Starting receiver..."
	@systemctl --user start webhooks-receiver
	@echo "Receiver deployed."

deploy-web:
	@echo "Building web app..."
	pnpm build
	@echo "Restarting web server..."
	@systemctl --user restart webhooks-web
	@echo "Web deployed."

deploy-all: deploy-receiver deploy-web

build-cli:
	cd apps/cli && goreleaser build --snapshot --clean

# Test
test:
	pnpm test
	pnpm test:convex
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo test
	cd apps/cli && go test ./...

# Lint
lint:
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo clippy -- -D warnings
	cd apps/cli && golangci-lint run

# Database
db-push:
	pnpm convex deploy

# Start (alias for prod — ensures services are running + opens log viewer)
start:
	@make prod

# Clean
clean:
	rm -rf dist
	rm -rf apps/web/.next
	rm -rf node_modules
	rm -rf apps/web/node_modules
	rm -rf packages/sdk/node_modules
	rm -rf apps/receiver-rs/target
