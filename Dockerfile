# syntax=docker/dockerfile:1

ARG GO_VERSION=1.27.3
ARG ALPINE_VERSION=3.24

# Run generators on the builder's architecture, then cross-compile the server.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build

ARG BUILDARCH
ARG SQLC_VERSION=1.31.1
ARG SQLC_SHA256_AMD64=497ae4fcdfa64c5b0c311ffe4c2bd991e43991e82e5367792ed78bc2dca27354
ARG SQLC_SHA256_ARM64=b7cae247740d0c51a1e657479e5b2d21e6fef428f596682a01bc55bf4ab8a23d
ARG PROTOC_GEN_GO_VERSION=1.36.11

ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src

RUN apk add --no-cache ca-certificates protoc protobuf-dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install google.golang.org/protobuf/cmd/protoc-gen-go@v${PROTOC_GEN_GO_VERSION}

# Verify the release archive before installing the pinned sqlc generator.
RUN set -eu; \
    case "${BUILDARCH}" in \
      amd64) checksum="${SQLC_SHA256_AMD64}" ;; \
      arm64) checksum="${SQLC_SHA256_ARM64}" ;; \
      *) echo "Unsupported builder architecture: ${BUILDARCH}" >&2; exit 1 ;; \
    esac; \
    archive="sqlc_${SQLC_VERSION}_linux_${BUILDARCH}.tar.gz"; \
    release="https://github.com/sqlc-dev/sqlc/releases/download/v${SQLC_VERSION}"; \
    cd /tmp; \
    wget -q "${release}/${archive}"; \
    echo "${checksum}  ${archive}" | sha256sum -c -; \
    tar -xzf "${archive}" -C /usr/local/bin sqlc; \
    rm -f "${archive}"

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download && go mod verify

# .dockerignore excludes local configuration, secrets and generated host files.
COPY sqlc.yaml ./
COPY migrations/schema.sql ./migrations/schema.sql
COPY api/proto ./api/proto
COPY internal ./internal
COPY cmd/server ./cmd/server

RUN sqlc generate \
    && protoc --go_out=. --go_opt=module=msgnr api/proto/packets.proto

ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" \
    -o /out/server ./cmd/server

FROM alpine:${ALPINE_VERSION} AS runtime

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10001 msgnr \
    && adduser -S -D -H -u 10001 -G msgnr msgnr

WORKDIR /app
COPY --from=build --chmod=0555 /out/server /usr/local/bin/server

# Credentials and deployment-specific settings must be supplied at runtime.
ENV ENV=production \
    PORT=8080 \
    METRICS_PORT=9090 \
    TZ=UTC

USER 10001:10001
EXPOSE 8080 9090
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -q -T 3 -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
ENTRYPOINT ["/usr/local/bin/server"]
