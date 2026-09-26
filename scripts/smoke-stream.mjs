/**
 * Live one-shot stream smoke; passes after a nonempty reply and stop completion.
 * Usage: CURSOR_ACCESS_TOKEN=... bun run smoke:stream
 * Uses the offered "default" model unless CURSOR_SMOKE_MODEL overrides it.
 */
import { createCursorNativeStream } from "../src/stream/native-core.ts";
import { getCursorModels } from "../src/stream/model-discovery.ts";

const token = process.env.CURSOR_ACCESS_TOKEN?.trim();
if (!token) {
  console.error("Set CURSOR_ACCESS_TOKEN");
  process.exit(1);
}

const modelId = process.env.CURSOR_SMOKE_MODEL || "default";
const offered = await getCursorModels(token);
if (!offered.some((m) => m.id === modelId)) {
  console.error(
    `smoke-stream: FAILED — model "${modelId}" is not offered to this account (set CURSOR_SMOKE_MODEL)`,
  );
  process.exit(1);
}

const streamFn = createCursorNativeStream({
  getAccessToken: async () => token,
  getNoReasoningEffortByModelId: () => new Map(),
  getRawModelRoutingByModelId: () => new Map(),
});

const model = {
  id: modelId,
  name: "smoke",
  provider: "cursor",
  api: "cursor-native",
  baseUrl: "https://agentn.us.api5.cursor.sh",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const stream = streamFn(
  model,
  {
    systemPrompt: "Reply with the single word pong.",
    messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
    tools: [],
  },
  { maxTokens: 64 },
);

let reply = "";
let stopped = false;
for await (const event of stream) {
  if (event.type === "text_delta") {
    reply += event.delta || "";
    process.stdout.write(event.delta || "");
  }
  if (event.type === "error") {
    console.error("\nerror:", event.error?.errorMessage || event);
    process.exit(1);
  }
  if (event.type === "done") {
    console.log("\nstop:", event.reason);
    stopped ||= event.reason === "stop";
  }
}
if (!reply.trim() || !stopped) {
  console.error(`smoke-stream: FAILED — ${!reply.trim() ? "empty reply" : "stream did not stop"}`);
  process.exit(1);
}
console.log("smoke-stream: ok");
// An open HTTP/2 session keeps the event loop alive after the stream finishes.
process.exit(0);
