# syntax=docker/dockerfile:1

# --- build ---
FROM golang:1.25-alpine AS build

# protoc + protoc-gen-go: regenerate internal/gen/proto from api/proto —
# the generated code is gitignored / can be stale relative to packets.proto.
RUN apk add --no-cache protoc protobuf-dev \
    && go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
ENV PATH=$PATH:/root/go/bin

# sqlc: regenerate internal/gen/queries from internal/repo/queries + schema.
ARG TARGETARCH
ADD https://github.com/sqlc-dev/sqlc/releases/download/v1.31.1/sqlc_1.31.1_linux_${TARGETARCH}.tar.gz /tmp/sqlc.tar.gz
RUN tar -xzf /tmp/sqlc.tar.gz -C /usr/local/bin sqlc

WORKDIR /src
ENV CGO_ENABLED=0

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN sqlc generate \
    && protoc --go_out=. --go_opt=module=msgnr api/proto/packets.proto \
    && go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# --- run ---
FROM alpine:3.21

RUN apk add --no-cache ca-certificates \
    && adduser -D -H -u 10001 msgnr

COPY --from=build /out/server /usr/local/bin/server

USER msgnr
EXPOSE 8080 9090
ENTRYPOINT ["server"]
