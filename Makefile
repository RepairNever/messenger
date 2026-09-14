.PHONY: proto sqlc build build-linux run clean test test-unit test-events test-integration deps

# Generate protobuf Go code
proto:
	@echo "Generating protobuf code..."
	@mkdir -p internal/gen/proto
	protoc --go_out=. --go_opt=module=msgnr \
		api/proto/packets.proto

# Generate sqlc Go code
sqlc:
	@echo "Generating sqlc code..."
	sqlc generate

# Install protobuf tools
proto-tools:
	go install google.golang.org/protobuf/cmd/protoc-gen-go@latest

# Build the server
build: proto sqlc
	go build -trimpath -o server ./cmd/server

build-linux: proto sqlc
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -installsuffix cgo -trimpath -o server-linux ./cmd/server

# Run the server
run: proto sqlc
	go run ./cmd/server

# Clean build artifacts
clean:
	rm -f server
	rm -rf internal/gen/

# Install dependencies
deps:
	go mod tidy

# Run all Go tests
test: proto sqlc
	go test ./...

# Run only unit tests (no DB required)
test-unit:
	go test ./internal/auth/... ./internal/events/... ./internal/ws/... -v -count=1

# Run Phase 3 event pipeline tests
test-events:
	go test ./internal/events/... ./internal/ws/... -v -count=1

# Run Testcontainers-based integration tests (requires Docker)
test-integration:
	go test -tags=integration ./internal/events/... ./internal/dayoffs/... -v -count=1 -timeout=120s
