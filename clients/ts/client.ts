import { claudeClient } from ".";

/** Claude model ID to use for requests */
const CLAUDE_MODEL = "claude-3-5-haiku-20241022";
/** Maximum number of tokens to generate in the response */
const MAX_TOKENS = 1000;

/**
 * Main function that demonstrates both streaming and non-streaming requests to Claude
 */
async function main() {
  try {
    await nonStreamingExample();
    await streamingExample();
  } catch (error) {
    console.error("Error communicating with Claude:", error);
  }
}

/**
 * Demonstrates a basic non-streaming request to Claude
 * Asks Claude to explain quantum computing in two sentences
 */
async function nonStreamingExample() {
  console.log("Sending message to Claude via proxy (non-streaming)...");

  const response = await claudeClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: "Explain quantum computing in one brief sentence.",
      },
    ],
  });

  console.log("\nClaude Response (non-streaming):");
  console.log("-------------------------------");
  if (response.content[0].type === "text") {
    console.log(response.content[0].text);
  }
}

/**
 * Demonstrates a streaming request to Claude
 * Asks Claude to write a short poem about programming and streams the response
 */
async function streamingExample() {
  console.log("\nSending streaming message to Claude via proxy...");

  // Create a streaming messages request
  const stream = await claudeClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: "Write a haiku about programming.",
      },
    ],
    stream: true,
  });

  // Process the stream
  console.log("\nClaude Response (streaming):");
  console.log("----------------------------");

  let contentText = "";

  for await (const chunk of stream) {
    if (
      chunk.type === "content_block_delta" &&
      chunk.delta.type === "text_delta"
    ) {
      process.stdout.write(chunk.delta.text);
      contentText += chunk.delta.text;
    }
  }
}

// Execute main function if this file is run directly
if (require.main === module) {
  main();
}
