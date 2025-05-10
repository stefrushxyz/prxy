# PRXY

A lightweight proxy server for the Anthropic Claude API.

## Overview

PRXY is a simple proxy server that sits between your application and Anthropic's Claude API. It offers:

- Seamless forwarding of requests to Claude's API
- Streaming support
- API key whitelisting
- CORS configuration for web applications
- Request/response logging
- Health check endpoint

## Installation

### Prerequisites

- Go 1.20 or higher
- Make (optional, for using the Makefile commands)

### Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/stefrushxyz/prxy.git
   cd prxy
   ```

2. Install dependencies:

   ```bash
   go mod download
   ```

3. Build the application:
   ```bash
   make build
   # or without make:
   go build -o bin/prxy main.go
   ```

## Usage

### Running the Server

```bash
make run
# or without make:
go run main.go
```

By default, the server will run on port 3000.

### Environment Variables

Create a `.env` file in the project root with the following variables:

```
PORT=3000
CLAUDE_API_URL=https://api.anthropic.com
ALLOWED_API_KEYS=key1,key2,key3
```

- `PORT`: The port on which the proxy server will run (default: 3000)
- `CLAUDE_API_URL`: The base URL for the Claude API (default: https://api.anthropic.com)
- `ALLOWED_API_KEYS`: Comma-separated list of API keys that are allowed to use the proxy. When set, only requests with an API key matching one in this list will be forwarded to Claude API. API keys can be provided via the `x-api-key` header or the `Authorization` header (with `Bearer` prefix). If this variable is not set, all API keys will be accepted.

### API Endpoints

- **Health Check**: `GET /health`

  - Returns a simple status check to verify the server is running

- **Claude API Proxy**: `POST /api/v1/messages`
  - Forwards requests to the Claude API's `/v1/messages` endpoint
  - Streaming is disabled by default (no need to set `stream: false`)
  - Preserves necessary headers (Authorization, x-api-key, anthropic-version, anthropic-beta)

## Docker

You can also run PRXY using Docker:

### Building the Docker Image

```bash
docker build -t prxy .
```

### Running the Docker Container

```bash
docker run -p 3000:3000 --env-file .env prxy
```

This will expose the PRXY server on port 3000 on your host machine and use the environment variables from your .env file.

## Cloud Deployment

### AWS Deployment with GitHub Actions

PRXY includes a complete GitHub Actions workflow that deploys the server to AWS using:

- **Docker containers** for easy deployment
- **Amazon ECR** for container registry
- **Amazon EC2** for hosting the server
- **Pulumi** for infrastructure as code

To use the AWS deployment:

1. Set up the required GitHub repository secrets:

   - `AWS_ACCESS_KEY_ID`: AWS access key with permissions for ECR, EC2, S3, and IAM
   - `AWS_SECRET_ACCESS_KEY`: Corresponding AWS secret key
   - `PULUMI_ACCESS_TOKEN`: Access token for your Pulumi account
   - `S3_BUCKET`: Name of the S3 bucket to store environment files
   - `ALLOWED_API_KEYS`: Comma-separated list of API keys allowed to use the proxy

2. Push to your `main` branch or manually trigger the workflow

See the [infra/README.md](infra/README.md) file for more details on the AWS deployment.

## Client Examples

The repository includes example clients in different languages:

### Go Client

```bash
make client-go
# or without make:
go run clients/go/client.go
```

### TypeScript Client

```bash
make client-ts
# or without make:
cd clients/ts && npm install && npm run start
```

### Client Environment Configuration

For both client examples, create a `.env` file in the client project root (root directory for Go, `clients/ts/` directory for TypeScript) with the following variables:

```
CLAUDE_API_KEY=your_claude_api_key_here
PRXY_URL=http://localhost:3000
```

- `CLAUDE_API_KEY`: Your Anthropic Claude API key (required)
- `PRXY_URL`: URL of the running PRXY server (default: http://localhost:3000)

### cURL Example

You can also use cURL to test the proxy server:

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_claude_api_key_here" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "max_tokens": 1000,
    "stream": false,
    "messages": [
      {
        "role": "user",
        "content": "Hello, Claude!"
      }
    ]
  }'
```

Note that `stream: false` is the default behavior. For streaming responses, explicitly set `stream: true`:

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_claude_api_key_here" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-haiku-20241022",
    "max_tokens": 1000,
    "stream": true,
    "messages": [
      {
        "role": "user",
        "content": "Hello, Claude!"
      }
    ]
  }'
```

## Development

### Project Structure

- `main.go`: Main application code
- `clients/`: Example client implementations
  - `go/`: Go client example
  - `ts/`: TypeScript client example
- `Makefile`: Build and run commands

### Available Make Commands

- `make build`: Build the server
- `make run`: Run the server
- `make client-go`: Run the Go client example
- `make client-ts`: Run the TypeScript client example
- `make clean`: Clean build artifacts
