import { claudeClient } from ".";

/** Claude model ID to use for requests */
const CLAUDE_MODEL = "claude-3-5-haiku-20241022";
/** Maximum number of tokens to generate in the response */
const MAX_TOKENS = 1000;

// Simple ANSI color codes implementation
const chalk = {
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
};

/**
 * Main function that demonstrates both streaming and non-streaming requests to Claude
 */
async function main() {
  try {
    console.log(chalk.bold("Claude Client"));
    console.log(chalk.cyan("===================="));
    console.log();

    await nonStreamingExample();
    console.log();
    console.log(chalk.cyan("===================="));
    console.log();

    await streamingExample();
  } catch (error) {
    console.error(
      chalk.yellow("Error:"),
      "Error communicating with Claude:",
      error
    );
  }
}

/**
 * Demonstrates a basic non-streaming request to Claude
 * Asks Claude to explain quantum computing in two sentences
 */
async function nonStreamingExample() {
  console.log(chalk.bold("Non-streaming Example"));

  const message = "Give me one interesting fact about the moon.";

  const request = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user" as const,
        content: message,
      },
    ],
  };

  console.log(chalk.bold("Sending request to Claude API..."));
  console.log();

  const startTime = Date.now();
  const response = await claudeClient.messages.create(request);
  const elapsed = (Date.now() - startTime) / 1000;

  console.log(chalk.bold("Response from Claude:"));
  console.log(chalk.cyan("===================="));

  let responseText = "";
  if (response.content[0].type === "text") {
    responseText = response.content[0].text;
    console.log(responseText);
  }

  // Print stats
  console.log();
  console.log();
  console.log(chalk.cyan("===================="));
  console.log(
    `${chalk.bold("Time elapsed:")} ${chalk.green(
      `${elapsed.toFixed(2)} seconds`
    )}`
  );
  console.log(
    `${chalk.bold("Response length:")} ${chalk.green(
      `${responseText.length} characters`
    )}`
  );
  console.log(chalk.cyan("===================="));
}

/**
 * Demonstrates a streaming request to Claude
 * Asks Claude to write a short poem about programming and streams the response
 */
async function streamingExample() {
  console.log(chalk.bold("Streaming Example"));

  const message = "Write a haiku about computer science.";

  const request = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user" as const,
        content: message,
      },
    ],
    stream: true as const,
  };

  console.log(chalk.bold("Sending request to Claude API..."));
  console.log();

  const startTime = Date.now();
  const stream = await claudeClient.messages.create(request);

  console.log(chalk.bold("Response from Claude:"));
  console.log(chalk.cyan("===================="));

  let responseText = "";
  let eventCount = 0;

  for await (const chunk of stream) {
    if (
      chunk.type === "content_block_delta" &&
      chunk.delta.type === "text_delta"
    ) {
      process.stdout.write(chunk.delta.text);
      responseText += chunk.delta.text;
      eventCount++;
    } else if (
      chunk.type === "content_block_start" &&
      chunk.content_block?.type === "text"
    ) {
      if (chunk.content_block.text) {
        process.stdout.write(chunk.content_block.text);
        responseText += chunk.content_block.text;
        eventCount++;
      }
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;

  // Print stats
  console.log();
  console.log();
  console.log(chalk.cyan("===================="));
  console.log(
    `${chalk.bold("Time elapsed:")} ${chalk.green(
      `${elapsed.toFixed(2)} seconds`
    )}`
  );
  console.log(
    `${chalk.bold("Events received:")} ${chalk.green(`${eventCount}`)}`
  );
  console.log(
    `${chalk.bold("Response length:")} ${chalk.green(
      `${responseText.length} characters`
    )}`
  );
  console.log(chalk.cyan("===================="));
}

// Execute main function if this file is run directly
if (require.main === module) {
  main();
}
