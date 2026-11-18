# syntax=docker/dockerfile:1.7
FROM rust:1.97.0-slim-bookworm AS builder
RUN apt-get update \
    && apt-get install --yes --no-install-recommends clang libclang-dev nodejs ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY crates/bakery-native /src/crates/bakery-native
COPY assets/bakery-mujoco /src/assets/bakery-mujoco
COPY assets/bakery-robots /src/assets/bakery-robots
COPY scripts/bakery-robots/install-native-sdk.mjs scripts/bakery-robots/package-native.mjs /src/scripts/bakery-robots/
RUN node scripts/bakery-robots/install-native-sdk.mjs /opt/mujoco
ENV MUJOCO_DIR=/opt/mujoco
RUN node scripts/bakery-robots/package-native.mjs /opt/bakery-native

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/bakery-native /opt/bakery-native
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["/opt/bakery-native/bakery-native"]
