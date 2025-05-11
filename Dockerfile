# Build stage
FROM golang:1.24-alpine AS builder

# Set working directory
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git

# Copy go.mod and go.sum files and download dependencies first (better caching)
COPY go.mod go.sum* ./
RUN go mod download

# Copy the source code
COPY . .

# Build the application with optimizations
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o /app/prxy

# Runtime stage
FROM alpine:3

# Set working directory
WORKDIR /app

# Create a non-root user and group to run the application
RUN addgroup -S prxy && adduser -S prxy -G prxy

# Install required packages
RUN apk --no-cache add ca-certificates tzdata curl

# Copy the binary from the builder stage
COPY --from=builder /app/prxy /app/prxy

# Set proper permissions
RUN chmod +x /app/prxy && \
    chown -R prxy:prxy /app

# Define the user to run the application
USER prxy

# Expose the port
EXPOSE 3000

# Add healthcheck
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=5 \
    CMD curl -f http://localhost:3000/health || exit 1

# Run the application
CMD ["/app/prxy"] 