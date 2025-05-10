.PHONY: build run client-go client-ts clean

# Default target
all: build

# Build the server
build:
	go build -o bin/prxy main.go

# Run the server
run:
	go run main.go

# Build and run the go client
client-go:
	go run clients/go/client.go

# Build and run the ts client
client-ts:
	cd clients/ts && npm install && npm run start

# Clean build artifacts
clean:
	rm -rf bin/