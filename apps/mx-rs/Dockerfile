# syntax=docker/dockerfile:1
#
# Build with apps/mx-rs as the context:
#   docker build -t webhooks-mx apps/mx-rs
#
# Runs on the MX host with host networking, so client IPs are exact. The
# binary carries the cap_net_bind_service file capability, so it binds port
# 25 as a non-root user; keep NET_BIND_SERVICE in the container's capability
# set (with `cap_drop: [ALL]`, add `cap_add: [NET_BIND_SERVICE]`), or the
# binary cannot even start. TLS is rustls with ring, so the runtime needs only
# CA certificates.

FROM rust:1.98-slim-trixie AS builder
RUN apt-get update && apt-get install -y --no-install-recommends libcap2-bin \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Build the dependencies against a stub main first, so that layer survives
# source changes.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release --locked && rm -rf src

COPY src ./src
RUN touch src/main.rs && cargo build --release --locked \
    && setcap cap_net_bind_service=+ep target/release/webhooks-mx

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10002 --no-create-home mx \
    && install -d -o mx -g mx /var/lib/webhooks-mx
COPY --from=builder /app/target/release/webhooks-mx /usr/local/bin/webhooks-mx

ARG GIT_SHA=
# The retry store lives in MX_STATE_DIR; mount a volume there so a restart
# keeps it.
ENV GIT_SHA=$GIT_SHA \
    MX_STATE_DIR=/var/lib/webhooks-mx \
    MX_HEALTH_ADDR=127.0.0.1:8025

USER mx
VOLUME /var/lib/webhooks-mx
EXPOSE 25
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS -o /dev/null "http://${MX_HEALTH_ADDR}/" || exit 1
CMD ["webhooks-mx"]
