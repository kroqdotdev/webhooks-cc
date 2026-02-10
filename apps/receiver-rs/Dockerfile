FROM rust:1.90-slim AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first for dependency caching
COPY Cargo.toml Cargo.lock ./

# Create dummy main to cache dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src

# Copy actual source
COPY src ./src

# Touch main.rs to force rebuild of our code (not deps)
RUN touch src/main.rs
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /

COPY --from=builder /app/target/release/webhooks-receiver /receiver

EXPOSE 3001

CMD ["/receiver"]
