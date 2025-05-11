// Go client for Claude AI proxy server - PRXY
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/joho/godotenv"
)

const (
	// Claude model ID to use for requests
	ClaudeModel = "claude-3-5-haiku-20241022"
	// Maximum number of tokens to generate in the response
	MaxTokens = 1000
)

// ClaudeRequest represents the structure of a request to Claude API
type ClaudeRequest struct {
	Model     string    `json:"model"`
	MaxTokens int       `json:"max_tokens"`
	Stream    bool      `json:"stream"`
	Messages  []Message `json:"messages"`
}

// Message represents a single message in the conversation
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// StreamingResponse represents a chunk of a streaming response
type StreamingResponse struct {
	Type         string       `json:"type"`
	Index        int          `json:"index"`
	Delta        Delta        `json:"delta,omitempty"`
	ContentBlock ContentBlock `json:"content_block,omitempty"`
}

// Delta contains the actual content in a streaming response
type Delta struct {
	Text string `json:"text"`
}

// ContentBlock contains the content in a content block response
type ContentBlock struct {
	Text string `json:"text"`
}

// FullResponse represents the complete non-streaming response
type FullResponse struct {
	ID           string    `json:"id"`
	Type         string    `json:"type"`
	Role         string    `json:"role"`
	Content      []Content `json:"content"`
	Model        string    `json:"model"`
	StopReason   string    `json:"stop_reason"`
	StopSequence string    `json:"stop_sequence"`
}

// Content represents the content part of a response
type Content struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func main() {
	err := godotenv.Load()
	if err != nil {
		log.Println("Warning: No .env file found")
	}

	bold := color.New(color.Bold).SprintFunc()
	cyan := color.New(color.FgCyan).SprintFunc()
	green := color.New(color.FgGreen).SprintFunc()
	yellow := color.New(color.FgYellow).SprintFunc()

	fmt.Println(bold("Claude Client"))
	fmt.Println(cyan("===================="))
	fmt.Println()

	// Get proxy URL from environment variable or use default
	proxyURL := os.Getenv("PRXY_URL")
	if proxyURL == "" {
		proxyURL = "http://localhost:3000"
	}

	// Get API key from environment variable
	apiKey := os.Getenv("CLAUDE_API_KEY")
	if apiKey == "" {
		fmt.Printf("%s: CLAUDE_API_KEY environment variable not set\n", yellow("Error"))
		os.Exit(1)
	}

	// Example 1: Non-streaming request
	fmt.Println(bold("Non-streaming Example"))
	nonStreamingRequest := ClaudeRequest{
		Model:     ClaudeModel,
		MaxTokens: MaxTokens,
		Messages: []Message{
			{
				Role:    "user",
				Content: "Give me one interesting fact about the moon.",
			},
		},
	}

	// Send non-streaming request and process response
	sendRequest(nonStreamingRequest, proxyURL, apiKey, bold, cyan, yellow, green)

	fmt.Println()
	fmt.Println(cyan("===================="))
	fmt.Println()

	// Example 2: Streaming request
	fmt.Println(bold("Streaming Example"))
	streamingRequest := ClaudeRequest{
		Model:     ClaudeModel,
		MaxTokens: MaxTokens,
		Stream:    true,
		Messages: []Message{
			{
				Role:    "user",
				Content: "Write a haiku about computer science.",
			},
		},
	}

	// Send streaming request and process response
	sendRequest(streamingRequest, proxyURL, apiKey, bold, cyan, yellow, green)
}

// sendRequest sends a request to the Claude API and processes the response
func sendRequest(request ClaudeRequest, proxyURL string, apiKey string, bold, cyan, yellow, green func(a ...interface{}) string) {
	// Convert request to JSON
	requestBody, err := json.Marshal(request)
	if err != nil {
		fmt.Printf("%s: %v\n", yellow("Error marshalling request"), err)
		os.Exit(1)
	}

	fmt.Println(bold("Sending request to Claude API..."))
	fmt.Println()

	// Create a new HTTP request
	req, err := http.NewRequest("POST", proxyURL+"/v1/messages", bytes.NewBuffer(requestBody))
	if err != nil {
		fmt.Printf("%s: %v\n", yellow("Error creating request"), err)
		os.Exit(1)
	}

	// Set headers
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)

	// Record start time before sending the request
	startTime := time.Now()

	// Send request to proxy server
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("%s: %v\n", yellow("Error sending request to proxy"), err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	// Check if response is successful
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		fmt.Printf("%s: %s\n", yellow("Error from server"), string(body))
		os.Exit(1)
	}

	fmt.Println(bold("Response from Claude:"))
	fmt.Println(cyan("===================="))

	// Variables for handling
	responseText := ""
	eventCount := 0

	if request.Stream {
		// Handle streaming response
		reader := bufio.NewReader(resp.Body)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				if err != io.EOF {
					fmt.Printf("%s: %v\n", yellow("Error reading stream"), err)
				}
				break
			}

			// Skip empty lines
			line = strings.TrimSpace(line)
			if line == "" || !strings.HasPrefix(line, "data: ") {
				continue
			}

			// Extract the JSON data
			data := strings.TrimPrefix(line, "data: ")

			// Check for [DONE] message
			if data == "[DONE]" {
				break
			}

			// Parse the streaming response
			var streamResp StreamingResponse
			if err := json.Unmarshal([]byte(data), &streamResp); err != nil {
				fmt.Printf("%s: %v\n", yellow("Error parsing JSON"), err)
				continue
			}

			// Process based on event type
			if streamResp.Type == "content_block_delta" {
				// Print the delta text without a newline to make it appear as continuous text
				fmt.Print(streamResp.Delta.Text)
				responseText += streamResp.Delta.Text
				eventCount++
			} else if streamResp.Type == "content_block_start" {
				if streamResp.ContentBlock.Text != "" {
					fmt.Print(streamResp.ContentBlock.Text)
					responseText += streamResp.ContentBlock.Text
				}
				eventCount++
			}
		}
	} else {
		// Handle non-streaming response
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			fmt.Printf("%s: %v\n", yellow("Error reading response"), err)
			os.Exit(1)
		}

		var fullResp FullResponse
		if err := json.Unmarshal(body, &fullResp); err != nil {
			fmt.Printf("%s: %v\n", yellow("Error parsing JSON"), err)
			// Print raw response if parsing fails
			fmt.Println(string(body))
			os.Exit(1)
		}

		// Extract and print the text content
		for _, content := range fullResp.Content {
			if content.Type == "text" {
				fmt.Println(content.Text)
				responseText = content.Text
			}
		}
	}

	// Print stats
	elapsed := time.Since(startTime)
	fmt.Println()
	fmt.Println()
	fmt.Println(cyan("===================="))
	fmt.Printf("%s %s\n", bold("Time elapsed:"), green(fmt.Sprintf("%.2f seconds", elapsed.Seconds())))
	if request.Stream {
		fmt.Printf("%s %s\n", bold("Events received:"), green(fmt.Sprintf("%d", eventCount)))
	}
	fmt.Printf("%s %s\n", bold("Response length:"), green(fmt.Sprintf("%d characters", len(responseText))))
	fmt.Println(cyan("===================="))
}
