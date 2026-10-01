# syntax=docker/dockerfile:1
#
# Build with apps/receiver-rs as the context:
#   docker build -t webhooks-receiver apps/receiver-rs
#
# The builder and the runtime share a Debian release so the binary's glibc
# matches. TLS is rustls throughout, so the runtime needs only CA certificates.

FROM rust:1.98-slim-trixie AS builder
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Build the dependencies against a stub main first, so that layer survives
# source changes.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release --locked && rm -rf src

COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home receiver \
    && install -d -o receiver -g receiver /var/log/receiver
COPY --from=builder /app/target/release/webhooks-receiver /usr/local/bin/receiver

ARG GIT_SHA=
# The receiver also writes a daily JSON log file; mount a volume here to keep
# it across container replacements.
ENV GIT_SHA=$GIT_SHA \
    PORT=3001 \
    RECEIVER_LOG_DIR=/var/log/receiver

USER receiver
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["receiver"]
