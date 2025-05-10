package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/mux"
	"github.com/joho/godotenv"
	"github.com/rs/cors"
)

// Default values if environment variables are not set
const (
	defaultPort      = "3000"
	defaultClaudeURL = "https://api.anthropic.com"
	anthropicVersion = "2023-06-01"
	timeout          = 5 * time.Minute
	shutdownTimeout  = 30 * time.Second
)

// Custom type for context keys to avoid collisions
type contextKey string

// Key for request ID in context
const requestIDKey contextKey = "requestID"

// main is the entry point for the proxy server
func main() {
	// Configure logger with timestamp
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("Starting Claude proxy server...")

	// Load environment variables from .env file
	err := godotenv.Load()
	if err != nil {
		log.Println("Warning: No .env file found")
	}

	// Check for allowed API keys configuration
	allowedAPIKeysStr := os.Getenv("ALLOWED_API_KEYS")
	if allowedAPIKeysStr != "" {
		log.Println("API key validation is enabled")
	} else {
		log.Println("Warning: No ALLOWED_API_KEYS set - all API keys will be accepted")
	}

	// Set up the router
	r := mux.NewRouter()

	// Health check endpoint
	r.HandleFunc("/health", loggingMiddleware(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Context().Value(requestIDKey).(string)
		log.Printf("[%s] Health check request from %s", requestID, r.RemoteAddr)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})).Methods("GET")

	// Claude API proxy endpoint
	r.HandleFunc("/api/v1/messages", loggingMiddleware(claudeProxyHandler)).Methods("POST")

	// Set up CORS
	c := cors.New(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "OPTIONS"},
		AllowedHeaders:   []string{"Content-Type", "Authorization", "x-api-key", "anthropic-version", "anthropic-beta"},
		AllowCredentials: true,
	})
	handler := c.Handler(r)

	// Get port from environment variable or use default
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	// Get Claude API URL for logging
	claudeURL := os.Getenv("CLAUDE_API_URL")
	if claudeURL == "" {
		claudeURL = defaultClaudeURL
	}
	log.Printf("Using Claude API URL: %s", claudeURL)

	// Create a new server
	serverAddr := ":" + port
	server := &http.Server{
		Addr:    serverAddr,
		Handler: handler,
	}

	// Create a context that will be canceled on shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Start the server in a goroutine
	go func() {
		log.Printf("Claude proxy server running at http://localhost:%s", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("Server error: %v", err)
			cancel() // Cancel context to trigger shutdown
		}
	}()

	// Set up signal catching
	signalChan := make(chan os.Signal, 1)
	// Capture all termination signals
	signal.Notify(signalChan, os.Interrupt, syscall.SIGTERM, syscall.SIGINT)

	// Block until we receive a signal or context is canceled
	select {
	case sig := <-signalChan:
		log.Printf("Received signal: %v. Shutting down server...", sig)
	case <-ctx.Done():
		log.Println("Shutting down server due to error...")
	}

	// Create a deadline context for shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer shutdownCancel()

	// Attempt graceful shutdown
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("Server shutdown failed: %v", err)
	} else {
		log.Println("Server shutdown gracefully")
	}
}

// loggingMiddleware is a middleware for logging requests
func loggingMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Generate request ID
		requestID := fmt.Sprintf("%d", time.Now().UnixNano())

		// Create a new context with the request ID
		ctx := context.WithValue(r.Context(), requestIDKey, requestID)

		// Create a new request with the updated context
		r = r.WithContext(ctx)

		startTime := time.Now()
		log.Printf("[%s] Request received: %s %s from %s", requestID, r.Method, r.URL.Path, r.RemoteAddr)

		next(w, r)

		duration := time.Since(startTime)
		log.Printf("[%s] Request completed in %v", requestID, duration)
	}
}

// validateAPIKey checks if the provided API key is in the list of allowed keys
func validateAPIKey(key string) bool {
	if key == "" {
		return false
	}

	allowedAPIKeysStr := os.Getenv("ALLOWED_API_KEYS")
	if allowedAPIKeysStr == "" {
		// If no allowed keys are configured, accept all keys (with a warning already logged at startup)
		return true
	}

	// Split the comma-separated list of allowed API keys
	allowedAPIKeys := strings.Split(allowedAPIKeysStr, ",")

	// Trim whitespace from each key
	for i, k := range allowedAPIKeys {
		allowedAPIKeys[i] = strings.TrimSpace(k)
	}

	// Check if the provided key is in the list of allowed keys
	for _, allowedKey := range allowedAPIKeys {
		if key == allowedKey {
			return true
		}
	}

	return false
}

// extractAPIKey gets the API key from either the Authorization header or x-api-key header
func extractAPIKey(r *http.Request) string {
	// Try to get the key from the x-api-key header first
	apiKey := r.Header.Get("x-api-key")
	if apiKey != "" {
		return apiKey
	}

	// If not found, try to extract from the Authorization header
	authHeader := r.Header.Get("Authorization")
	if strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimPrefix(authHeader, "Bearer ")
	}

	// No API key found
	return ""
}

// claudeProxyHandler handles the proxy request to the Claude API
func claudeProxyHandler(w http.ResponseWriter, r *http.Request) {
	// Get request ID from context
	requestID := r.Context().Value(requestIDKey).(string)
	log.Printf("[%s] Processing Claude API request", requestID)

	// Extract and validate API key
	apiKey := extractAPIKey(r)
	if !validateAPIKey(apiKey) {
		log.Printf("[%s] Unauthorized: Invalid API key", requestID)
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Unauthorized: Invalid API key",
		})
		return
	}

	// Read the request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("[%s] Error reading request body: %v", requestID, err)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Failed to read request body",
		})
		return
	}
	defer r.Body.Close()

	// Add stream parameter to the request body if it's not already present
	var requestData map[string]interface{}
	if err := json.Unmarshal(body, &requestData); err != nil {
		log.Printf("[%s] Invalid JSON in request body: %v", requestID, err)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Invalid JSON request body",
		})
		return
	}

	// Log model being used if present
	if model, ok := requestData["model"].(string); ok {
		log.Printf("[%s] Using model: %s", requestID, model)
	}

	// Check if client wants streaming
	streamRequested := false
	if streamValue, exists := requestData["stream"]; exists {
		if streamBool, ok := streamValue.(bool); ok {
			streamRequested = streamBool
		}
	}

	// For the Claude API, we need to ensure stream parameter matches what the client requested
	if !streamRequested {
		// For non-streaming requests, ensure stream is set to false
		requestData["stream"] = false
	}

	// Convert modified request back to JSON
	modifiedBody, err := json.Marshal(requestData)
	if err != nil {
		log.Printf("[%s] Failed to marshal modified request: %v", requestID, err)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Failed to process request",
		})
		return
	}

	// Get Claude API URL from environment variable or use default
	claudeURL := os.Getenv("CLAUDE_API_URL")
	if claudeURL == "" {
		claudeURL = defaultClaudeURL
	}

	// Create a new request to the Claude API (always use /v1/messages endpoint)
	claudeAPIURL := claudeURL + "/v1/messages"
	log.Printf("[%s] Forwarding request to Claude API at %s", requestID, claudeAPIURL)

	proxyReq, err := http.NewRequest("POST", claudeAPIURL, bytes.NewBuffer(modifiedBody))
	if err != nil {
		log.Printf("[%s] Failed to create proxy request: %v", requestID, err)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Failed to create proxy request",
		})
		return
	}

	// Set the required headers
	proxyReq.Header.Set("Content-Type", "application/json")
	proxyReq.Header.Set("anthropic-version", anthropicVersion)

	// Copy relevant headers from the original request
	for header, values := range r.Header {
		headerName := strings.ToLower(header)
		if headerName == "authorization" ||
			headerName == "x-api-key" ||
			headerName == "anthropic-version" ||
			headerName == "anthropic-beta" {
			for _, value := range values {
				proxyReq.Header.Set(header, value)
				// Log headers being set (but hide actual auth values)
				if headerName == "authorization" || headerName == "x-api-key" {
					log.Printf("[%s] Forwarding header: %s: [REDACTED]", requestID, header)
				} else {
					log.Printf("[%s] Forwarding header: %s: %s", requestID, header, value)
				}
			}
		}
	}

	// Send the request to Claude API
	startTime := time.Now()
	client := &http.Client{
		Timeout: timeout,
	}
	resp, err := client.Do(proxyReq)
	if err != nil {
		log.Printf("[%s] Failed to send request to Claude API: %v", requestID, err)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to send request to Claude API: %v", err),
		})
		return
	}
	defer resp.Body.Close()
	log.Printf("[%s] Claude API responded with status: %d in %v", requestID, resp.StatusCode, time.Since(startTime))

	// Copy response headers
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)

	// If not streaming or error occurred, just copy the response directly
	if !streamRequested || resp.StatusCode != http.StatusOK {
		responseBody, err := io.ReadAll(resp.Body)
		if err != nil {
			log.Printf("[%s] Error reading Claude API response body: %v", requestID, err)
			return
		}

		if resp.StatusCode != http.StatusOK {
			log.Printf("[%s] Claude API error response: %s", requestID, string(responseBody))
		} else {
			log.Printf("[%s] Sending complete non-streaming response (%d bytes)", requestID, len(responseBody))
		}

		// For proper handling of non-streaming responses, verify the JSON is valid
		// but pass it through without modification
		if !streamRequested && resp.StatusCode == http.StatusOK {
			// Just verify it's valid JSON
			var jsonCheck interface{}
			if err := json.Unmarshal(responseBody, &jsonCheck); err != nil {
				log.Printf("[%s] Warning: Invalid JSON in Claude API non-streaming response: %v", requestID, err)
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{
					"error": "Invalid JSON in Claude API response",
				})
				return
			}
		}

		// Set the appropriate content type for non-streaming responses
		if !streamRequested && resp.StatusCode == http.StatusOK {
			w.Header().Set("Content-Type", "application/json")
		}

		w.Write(responseBody)
		return
	}

	// For streaming responses, flush each chunk as it arrives
	log.Printf("[%s] Starting to stream response", requestID)
	flusher, ok := w.(http.Flusher)
	if !ok {
		log.Printf("[%s] Streaming not supported by server", requestID)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Streaming not supported by server",
		})
		return
	}

	// Stream the response
	buffer := make([]byte, 1024)
	bytesStreamed := 0
	streamStart := time.Now()

	// Set appropriate headers for Server-Sent Events (SSE)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	for {
		n, err := resp.Body.Read(buffer)
		if n > 0 {
			bytesStreamed += n
			_, writeErr := w.Write(buffer[:n])
			if writeErr != nil {
				log.Printf("[%s] Error writing to client: %v", requestID, writeErr)
				return
			}
			flusher.Flush()
		}
		if err != nil {
			if err != io.EOF {
				log.Printf("[%s] Error reading from Claude API: %v", requestID, err)
			} else {
				log.Printf("[%s] Finished streaming response: %d bytes in %v",
					requestID, bytesStreamed, time.Since(streamStart))
			}
			break
		}
	}
}
