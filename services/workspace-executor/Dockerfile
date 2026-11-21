# syntax=docker/dockerfile:1.7

FROM rust:1.97.0-slim-bookworm AS builder

# openh264 is C++. The compiler lives in the builder stage only; the runtime
# image below carries the statically linked binary and nothing else.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

COPY Cargo.toml Cargo.lock /src/
COPY crates/workspace-executor /src/crates/workspace-executor
COPY crates/media-inspect /src/crates/media-inspect
COPY crates/message-link-fetch /src/crates/message-link-fetch
COPY crates/custom-connector-fetch /src/crates/custom-connector-fetch
COPY crates/shop-gateway /src/crates/shop-gateway
COPY crates/cobot-protocol /src/crates/cobot-protocol

RUN cargo build --locked --release -p workspace-executor --bin workspace-executor

FROM debian:bookworm-slim

COPY --from=builder /src/target/release/workspace-executor /usr/local/bin/workspace-executor

USER 65532:65532

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/workspace-executor"]
