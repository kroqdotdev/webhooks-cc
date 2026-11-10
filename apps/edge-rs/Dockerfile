# syntax=docker/dockerfile:1
#
# Build with the repository root as the context (the edge uses the tunnel
# protocol crate in crates/tunnel):
#   docker build -f apps/edge-rs/Dockerfile -t webhooks-edge .
#
# Builds for the host's architecture: amd64 on CI and the staging LXC,
# arm64 on an Arm box. The builder and the runtime share a Debian release so
# the binary's glibc matches. The edge speaks plain HTTP to the web app on
# the private network and TLS ends at Caddy, so the runtime needs only CA
# certificates (for StatOSS).

FROM rust:1.98-slim-trixie AS builder
WORKDIR /src

# Build the dependencies against a stub main first, so that layer survives
# source changes.
COPY crates/tunnel crates/tunnel
COPY apps/edge-rs/Cargo.toml apps/edge-rs/Cargo.lock apps/edge-rs/
RUN mkdir apps/edge-rs/src && echo "fn main() {}" > apps/edge-rs/src/main.rs \
    && cd apps/edge-rs && cargo build --release --locked && rm -rf src

COPY apps/edge-rs/src apps/edge-rs/src
COPY apps/edge-rs/words.example.json apps/edge-rs/
RUN cd apps/edge-rs && touch src/main.rs && cargo build --release --locked

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home edge \
    && install -d -o edge -g edge /var/log/edge
COPY --from=builder /src/apps/edge-rs/target/release/webhooks-edge /usr/local/bin/edge

ARG GIT_SHA=
# The access log goes to a volume mounted at /var/log/edge (14 days).
# EDGE_WORDS_FILE must name the private list of brands and lure words,
# mounted read-only; the edge refuses to start without it.
# The control (4001) and relay (4002) ports listen on every interface inside
# the container, so stops, password changes and live relays work without
# further settings; publish them on the private address only (ops does).
ENV GIT_SHA=$GIT_SHA \
    LISTEN=0.0.0.0:4000 \
    CONTROL_LISTEN=0.0.0.0:4001 \
    RELAY_LISTEN=0.0.0.0:4002 \
    ACCESS_LOG_DIR=/var/log/edge

USER edge
EXPOSE 4000 4001 4002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:4000/__edge/health || exit 1
CMD ["edge"]
