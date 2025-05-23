package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
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
	name                    = "PRXY"
	defaultPort             = "3000"
	defaultClaudeURL        = "https://api.anthropic.com"
	defaultAnthropicVersion = "2023-06-01"
	timeout                 = 5 * time.Minute
	shutdownTimeout         = 30 * time.Second
)

// Custom type for context keys to avoid collisions
type contextKey string

// Key for request ID in context
const requestIDKey contextKey = "requestID"

// Color codes for terminal output
const (
	colorReset  = "\033[0m"
	colorRed    = "\033[31m"
	colorGreen  = "\033[32m"
	colorYellow = "\033[33m"
	colorBlue   = "\033[34m"
	colorPurple = "\033[35m"
	colorCyan   = "\033[36m"
)

// Log type prefixes with colors
const (
	prefixError   = colorRed + "[ERROR]" + colorReset + " "
	prefixWarning = colorYellow + "[WARN]" + colorReset + " "
	prefixInfo    = colorGreen + "[INFO]" + colorReset + " "
	prefixRequest = colorBlue + "[REQ]" + colorReset + " "
	prefixSystem  = colorPurple + "[SYS]" + colorReset + " "
)

// logError logs error messages
func logError(format string, v ...interface{}) {
	log.Printf(prefixError+format, v...)
}

// logWarning logs warning messages
func logWarning(format string, v ...interface{}) {
	log.Printf(prefixWarning+format, v...)
}

// logInfo logs informational messages
func logInfo(format string, v ...interface{}) {
	log.Printf(prefixInfo+format, v...)
}

// logRequest logs request-related messages
func logRequest(requestID, format string, v ...interface{}) {
	log.Printf(prefixRequest+"%s[%s]%s "+format, append([]interface{}{colorCyan, requestID, colorReset}, v...)...)
}

// logSystem logs system events
func logSystem(format string, v ...interface{}) {
	log.Printf(prefixSystem+format, v...)
}

// main is the entry point for the proxy server
func main() {
	// Configure logger with timestamp
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	logSystem("Starting %s...", name)

	// Load environment variables from .env file
	err := godotenv.Load()
	if err != nil {
		logWarning("No .env file found")
	}

	// Check for allowed API keys configuration
	allowedAPIKeysStr := os.Getenv("ALLOWED_API_KEYS")
	if allowedAPIKeysStr != "" {
		logInfo("API key validation is enabled")
	} else {
		logWarning("No ALLOWED_API_KEYS set - all API keys will be accepted")
	}

	// Set up the router
	r := mux.NewRouter()

	// Health check endpoint
	r.HandleFunc("/health", loggingMiddleware(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Context().Value(requestIDKey).(string)
		logRequest(requestID, "Health check request from %s", r.RemoteAddr)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})).Methods("GET")

	// Claude API proxy endpoint
	r.HandleFunc("/v1/messages", loggingMiddleware(claudeProxyHandler)).Methods("POST")

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
	logInfo("Using Claude API URL: %s", claudeURL)

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
		logSystem("%s server running at http://localhost:%s", name, port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logError("Server error: %v", err)
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
		logSystem("Received signal: %v. Shutting down server...", sig)
	case <-ctx.Done():
		logSystem("Shutting down server due to error...")
	}

	// Create a deadline context for shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer shutdownCancel()

	// Attempt graceful shutdown
	if err := server.Shutdown(shutdownCtx); err != nil {
		logError("Server shutdown failed: %v", err)
	} else {
		logSystem("Server shutdown gracefully")
	}
}

// loggingMiddleware is a middleware for logging requests
func loggingMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Generate random request ID (7-character hex format)
		randomBytes := make([]byte, 4)
		_, err := rand.Read(randomBytes)
		requestID := hex.EncodeToString(randomBytes)[:7]
		if err != nil {
			// Fallback to timestamp if random generation fails
			requestID = fmt.Sprintf("%d", time.Now().UnixNano())
		}

		// Create a new context with the request ID
		ctx := context.WithValue(r.Context(), requestIDKey, requestID)

		// Create a new request with the updated context
		r = r.WithContext(ctx)

		startTime := time.Now()
		logRequest(requestID, "%s→%s %s %s from %s", colorPurple, colorReset, r.Method, r.URL.Path, r.RemoteAddr)

		next(w, r)

		duration := time.Since(startTime)
		logRequest(requestID, "%s←%s Completed in %v", colorGreen, colorReset, duration)
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
	logRequest(requestID, "Processing Claude API request")

	// Extract and validate API key
	apiKey := extractAPIKey(r)
	if !validateAPIKey(apiKey) {
		logRequest(requestID, "Unauthorized: Invalid API key")
		w.WriteHeader(http.StatusUnauthorized)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Unauthorized: Invalid API key",
		})
		return
	}

	// Read the request body
	body, err := io.ReadAll(r.Body)
	if err != nil {
		logError("[%s] Error reading request body: %v", requestID, err)
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
		logError("[%s] Invalid JSON in request body: %v", requestID, err)
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Invalid JSON request body",
		})
		return
	}

	// Log model being used if present
	if model, ok := requestData["model"].(string); ok {
		logRequest(requestID, "Using model: %s", model)
	}

	// Check if client wants streaming
	streamRequested := false
	if streamValue, exists := requestData["stream"]; exists {
		if streamBool, ok := streamValue.(bool); ok {
			streamRequested = streamBool
		}
	}

	// For non-streaming requests, ensure stream is set to false
	if !streamRequested {
		requestData["stream"] = false
	}

	// Convert modified request back to JSON
	modifiedBody, err := json.Marshal(requestData)
	if err != nil {
		logError("[%s] Failed to marshal modified request: %v", requestID, err)
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
	logRequest(requestID, "Forwarding request to Claude API at %s", claudeAPIURL)

	proxyReq, err := http.NewRequest("POST", claudeAPIURL, bytes.NewBuffer(modifiedBody))
	if err != nil {
		logError("[%s] Failed to create proxy request: %v", requestID, err)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "Failed to create proxy request",
		})
		return
	}

	// Set the required headers
	proxyReq.Header.Set("Content-Type", "application/json")
	proxyReq.Header.Set("anthropic-version", defaultAnthropicVersion)

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
					logRequest(requestID, "Forwarding header: %s: [REDACTED]", header)
				} else {
					logRequest(requestID, "Forwarding header: %s: %s", header, value)
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
		logError("[%s] Failed to send request to Claude API: %v", requestID, err)
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf("Failed to send request to Claude API: %v", err),
		})
		return
	}
	defer resp.Body.Close()
	logRequest(requestID, "Claude API responded with status: %d in %v", resp.StatusCode, time.Since(startTime))

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
			logError("[%s] Error reading Claude API response body: %v", requestID, err)
			return
		}

		if resp.StatusCode != http.StatusOK {
			logError("[%s] Claude API error response: %s", requestID, string(responseBody))
		} else {
			logRequest(requestID, "Sending complete non-streaming response (%d bytes)", len(responseBody))
		}

		// For proper handling of non-streaming responses, verify the JSON is valid
		// but pass it through without modification
		if !streamRequested && resp.StatusCode == http.StatusOK {
			// Just verify it's valid JSON
			var jsonCheck interface{}
			if err := json.Unmarshal(responseBody, &jsonCheck); err != nil {
				logWarning("[%s] Invalid JSON in Claude API non-streaming response: %v", requestID, err)
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
	logRequest(requestID, "Starting to stream response")
	flusher, ok := w.(http.Flusher)
	if !ok {
		logError("[%s] Streaming not supported by server", requestID)
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
				logError("[%s] Error writing to client: %v", requestID, writeErr)
				return
			}
			flusher.Flush()
		}
		if err != nil {
			if err != io.EOF {
				logError("[%s] Error reading from Claude API: %v", requestID, err)
			} else {
				logRequest(requestID, "Finished streaming response: %d bytes in %v", bytesStreamed, time.Since(streamStart))
			}
			break
		}
	}
}
