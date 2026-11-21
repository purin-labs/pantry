# syntax=docker/dockerfile:1.7

FROM rust:1.97.0-slim-bookworm AS builder

WORKDIR /src
COPY Cargo.toml Cargo.lock /src/
COPY crates/workspace-executor /src/crates/workspace-executor
COPY crates/media-inspect /src/crates/media-inspect
COPY crates/message-link-fetch /src/crates/message-link-fetch
COPY crates/custom-connector-fetch /src/crates/custom-connector-fetch
COPY crates/shop-gateway /src/crates/shop-gateway
COPY crates/cobot-protocol /src/crates/cobot-protocol

RUN cargo build --locked --release -p custom-connector-fetch

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/target/release/custom-connector-fetch /usr/local/bin/custom-connector-fetch

USER 65532:65532

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/custom-connector-fetch"]
