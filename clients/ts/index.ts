import { Anthropic } from "@anthropic-ai/sdk";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Configuration interface
export interface ClaudeClientConfig {
  apiKey: string;
  prxyUrl: string;
}

/**
 * Creates an instance of the Anthropic client configured to use the proxy server
 */
export function createClaudeProxyClient(config: ClaudeClientConfig): Anthropic {
  // Use provided API key
  const apiKey = config.apiKey;
  if (!apiKey) {
    throw new Error("API key is required");
  }

  // Create Anthropic client with custom baseURL pointing to our proxy
  const client = new Anthropic({
    apiKey,
    baseURL: config.prxyUrl,
  });

  return client;
}

/**
 * Default client instance using environment variables
 */
export const claudeClient = createClaudeProxyClient({
  prxyUrl: process.env.PRXY_URL || "http://localhost:3000",
  apiKey: process.env.CLAUDE_API_KEY || "",
});

// Export Anthropic types for convenience
export * from "@anthropic-ai/sdk";
