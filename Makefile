.PHONY: dev dev-all dev-web dev-receiver dev-cli build build-receiver build-cli test test-full lint clean

# Development
dev:
	mprocs --config mprocs-dev.yaml

dev-web:
	pnpm --filter web dev

dev-receiver:
	@set -a && . ./.env.local && set +a && cd apps/receiver-rs && $$HOME/.cargo/bin/cargo run

dev-cli:
	cd apps/cli-rs && cargo run -- $(ARGS)

# Build
build:
	mkdir -p dist
	pnpm build
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo build --release && cp target/release/webhooks-receiver ../../dist/receiver
	cd apps/cli-rs && cargo build --release && cp target/release/whk ../../dist/whk

build-receiver:
	mkdir -p dist
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo build --release && cp target/release/webhooks-receiver ../../dist/receiver

build-cli:
	cd apps/cli-rs && cargo build --release

# Test
test:
	pnpm test
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo test
	cd apps/cli-rs && cargo test

test-full:
	pnpm typecheck
	pnpm build
	$(MAKE) test
	cd apps/web && pnpm test:integration
	cd apps/web && PLAYWRIGHT_USE_PROD_SERVER=1 pnpm test:e2e

# Lint
lint:
	cd apps/receiver-rs && $$HOME/.cargo/bin/cargo clippy -- -D warnings
	cd apps/cli-rs && cargo clippy -- -D warnings

# Clean
clean:
	rm -rf dist
	rm -rf apps/web/.next
	rm -rf node_modules
	rm -rf apps/web/node_modules
	rm -rf packages/sdk/node_modules
	rm -rf apps/receiver-rs/target
