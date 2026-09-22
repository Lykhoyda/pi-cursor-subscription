/**
 * Live end-to-end smoke: Pi Coding Agent + this package as the Cursor provider + Grok.
 *
 * Proves the whole path a user exercises — `pi` loads `dist/index.js`, the extension
 * registers the `cursor` provider, `--model` resolves to a real Cursor Grok variant
 * (4.7 when the account lists it, otherwise 4.6), and a trivial prompt streams a
 * non-empty reply back through pi's JSON event stream.
 *
 * Usage: bun run smoke:pi-grok
 *
 * Credentials come from the production cascade (env → Pi auth.json → Keychain → IDE DB).
 * Only the credential *source* is ever printed. Any error text is run through
 * redactSecrets() before it reaches stdout/stderr.
 *
 * Env:
 *   CURSOR_SMOKE_MODEL       collapsed Grok 4.7 or 4.6 model id (default: grok-4.7, then grok-4.6)
 *   CURSOR_SMOKE_THINKING    pi thinking level (default: low)
 *   CURSOR_SMOKE_PROMPT      user prompt (default: a one-word pong request)
 *   CURSOR_SMOKE_TIMEOUT_MS  hard kill for the pi process (default: 120000)
 *   PI_BIN                   explicit pi executable (default: `pi` on PATH, then node_modules/.bin/pi)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getStartupCursorAccessToken } from "../src/extension/auth.js";
import { augmentCursorModels } from "../src/models/parameterized.js";
import { processModels, type ProcessedModel } from "../src/models/processing.js";
import { discoverCursorCatalog } from "../src/stream/native-core.js";
import type { PiThinkingLevel } from "../src/types/enums.js";
import { redactSecrets } from "../src/utils/security.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DIST_ENTRY = join(ROOT, "dist", "index.js");
const DEFAULT_MODEL_PREFERENCE = ["grok-4.7", "cursor-grok-4.7", "grok-4.6", "cursor-grok-4.6"];
const GROK_SMOKE_ID = /grok-4\.[67]/;
const DEFAULT_PROMPT = "Reply with exactly one word: pong";
const DEFAULT_THINKING: PiThinkingLevel = "low";
const DEFAULT_TIMEOUT_MS = 120_000;
const REPLY_PREVIEW_CHARS = 200;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Selection {
  model: ProcessedModel;
  thinking: PiThinkingLevel;
}

/** The subset of pi's `--mode json` event lines this smoke reads. */
interface PiEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  message?: PiAssistantMessage;
}

interface PiAssistantMessage {
  role: string;
  content?: Array<{ type: string; text?: string }>;
  provider?: string;
  api?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number };
}

let logPrefix = "smoke-pi-grok";

export function setLogPrefix(prefix: string): void {
  logPrefix = prefix;
}

export function log(step: string, message: string): void {
  console.log(`[${logPrefix}] ${step}: ${redactSecrets(message)}`);
}

export function fail(step: string, message: string, details?: string): never {
  console.error(`[${logPrefix}] FAIL ${step}: ${redactSecrets(message)}`);
  if (details) console.error(redactSecrets(details).trimEnd());
  process.exit(1);
}

export async function resolveCredentialSource(): Promise<string> {
  const resolved = await getStartupCursorAccessToken();
  if (!resolved) {
    fail(
      "auth",
      "no Cursor credential resolved. Set CURSOR_ACCESS_TOKEN, run `/login cursor` in pi, or sign in to the Cursor app/CLI.",
    );
  }
  log("auth", `credential source=${resolved.source}`);
  return resolved.accessToken;
}

export async function pickGrokModel(accessToken: string): Promise<Selection> {
  // discoverCursorCatalog() also persists the on-disk catalog cache, which is what lets
  // pi register Grok at startup — the bundled fallback catalog has no Grok 4.7 row.
  const catalog = await discoverCursorCatalog(accessToken);
  const processed = processModels(
    augmentCursorModels(catalog.rawModels, catalog.parameterizedModels),
  );
  log(
    "catalog",
    `raw=${catalog.rawModels.length} parameterized=${catalog.parameterizedModels.length} registered=${processed.length}`,
  );

  const grokIds = processed.map((m) => m.id).filter((id) => GROK_SMOKE_ID.test(id));
  const override = process.env.CURSOR_SMOKE_MODEL?.trim();
  if (override && !GROK_SMOKE_ID.test(override)) {
    fail(
      "model",
      `CURSOR_SMOKE_MODEL=${override} is not a Grok 4.7 or 4.6 id`,
      `use one of: ${grokIds.join(", ")}`,
    );
  }
  const candidateIds = override
    ? [override]
    : [...DEFAULT_MODEL_PREFERENCE, ...grokIds.filter((id) => !/-(fast|max)(-|$)/.test(id))];
  const byId = new Map(processed.map((m) => [m.id, m]));
  const model = candidateIds.map((id) => byId.get(id)).find((m) => m !== undefined);
  if (!model) {
    fail(
      "model",
      override
        ? `CURSOR_SMOKE_MODEL=${override} is not in the provider's registered catalog`
        : "no Grok 4.7 or 4.6 model id registered by this provider",
      `grok ids available: ${grokIds.join(", ") || "(none)"}`,
    );
  }

  const thinking = (process.env.CURSOR_SMOKE_THINKING?.trim() || DEFAULT_THINKING) as PiThinkingLevel;
  const cursorEffort = model.effortMap?.[thinking];
  if (model.supportsEffort && !cursorEffort) {
    const allowed = Object.entries(model.effortMap ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k);
    fail(
      "model",
      `thinking level "${thinking}" is not offered for ${model.id}`,
      `allowed: ${allowed.join(", ")}`,
    );
  }
  const rawVariant = cursorEffort ? (model.rawModelByEffort?.[cursorEffort] ?? model.id) : model.id;
  log("model", `id=${model.id} name="${model.name}" thinking=${thinking} -> cursor=${rawVariant}`);
  return { model, thinking };
}

export function run(
  cmd: string,
  args: string[],
  timeoutMs?: number,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options?.cwd ?? ROOT,
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : undefined;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function buildDist(): Promise<void> {
  const result = await run(process.execPath, ["run", "build"]);
  if (result.code !== 0) fail("build", "bun run build failed", result.stderr || result.stdout);
  if (!existsSync(DIST_ENTRY)) fail("build", `${DIST_ENTRY} missing after build`);
  log("build", "dist/index.js ready");
}

export function locatePi(): string {
  const explicit = process.env.PI_BIN?.trim();
  if (explicit) return explicit;
  const onPath = Bun.which("pi");
  if (onPath) return onPath;
  const local = join(ROOT, "node_modules", ".bin", "pi");
  if (existsSync(local)) return local;
  fail(
    "pi",
    "pi executable not found. Install Pi Coding Agent, run `bun install` (peer dep), or set PI_BIN.",
  );
}

export function parseJsonLines(stdout: string): { events: PiEvent[]; nonJson: string[] } {
  const events: PiEvent[] = [];
  const nonJson: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      nonJson.push(trimmed);
    }
  }
  return { events, nonJson };
}

export function summarizeAssistant(events: PiEvent[]) {
  let deltaCount = 0;
  let streamed = "";
  const errorEvents: unknown[] = [];
  let finalMessage: PiAssistantMessage | undefined;

  for (const event of events) {
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        deltaCount += 1;
        streamed += inner.delta;
      }
      if (inner?.type === "error") errorEvents.push(inner);
    }
    if (event.type === "error") errorEvents.push(event);
    if (event.type === "message_end" && event.message?.role === "assistant") {
      finalMessage = event.message;
    }
  }

  const finalText = (finalMessage?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");

  return { deltaCount, streamed, finalText, finalMessage, errorEvents };
}

async function runPi({ model, thinking }: Selection): Promise<void> {
  const piBin = locatePi();
  const version = await run(piBin, ["--version"]);
  log("pi", `bin=${piBin} version=${(version.stdout || version.stderr).trim() || "unknown"}`);

  const prompt = process.env.CURSOR_SMOKE_PROMPT?.trim() || DEFAULT_PROMPT;
  const timeoutMs = Number(process.env.CURSOR_SMOKE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const args = [
    "--print",
    "--mode",
    "json",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-session",
    "--no-tools",
    "--extension",
    DIST_ENTRY,
    "--provider",
    "cursor",
    "--model",
    model.id,
    "--thinking",
    thinking,
    // No `--` separator: pi < 0.85 rejects it, and the prompt never starts with a dash.
    prompt,
  ];
  log("pi", `prompt="${prompt}" timeout=${timeoutMs}ms`);

  const startedAt = Date.now();
  const result = await run(piBin, args, timeoutMs);
  const elapsedMs = Date.now() - startedAt;

  if (result.timedOut) fail("pi", `no completion within ${timeoutMs}ms`, result.stderr);
  if (result.code !== 0) {
    fail("pi", `exited with code ${result.code}`, `${result.stderr}\n${result.stdout}`);
  }

  const { events, nonJson } = parseJsonLines(result.stdout);
  const summary = summarizeAssistant(events);

  if (summary.errorEvents.length > 0) {
    fail("stream", "pi reported error events", JSON.stringify(summary.errorEvents, null, 2));
  }
  if (!summary.finalMessage) {
    fail("stream", "no assistant message_end in pi output", `${result.stderr}\n${nonJson.join("\n")}`);
  }
  const { provider, api, model: reportedModel, stopReason, usage } = summary.finalMessage;
  if (provider !== "cursor" || api !== "cursor-native") {
    fail("stream", `reply did not come through this provider (provider=${provider} api=${api})`);
  }
  if (reportedModel !== model.id) {
    fail("stream", `reply model mismatch: expected ${model.id}, got ${reportedModel}`);
  }
  if (stopReason !== "stop") {
    fail(
      "stream",
      `assistant stopReason=${stopReason}`,
      summary.finalMessage.errorMessage ?? JSON.stringify(summary.finalMessage, null, 2),
    );
  }
  if (summary.deltaCount === 0) fail("stream", "no text_delta events streamed");
  if (!summary.finalText.trim()) fail("stream", "assistant reply text is empty");

  const preview = summary.finalText.replace(/\s+/g, " ").trim().slice(0, REPLY_PREVIEW_CHARS);
  log(
    "stream",
    `text_delta=${summary.deltaCount} streamedChars=${summary.streamed.length} elapsed=${elapsedMs}ms ` +
      `usage(in=${usage?.input ?? "?"} out=${usage?.output ?? "?"})`,
  );
  log("reply", `"${preview}"`);
  if (!/pong/i.test(summary.finalText)) {
    log("reply", "note: reply did not contain the requested word; streaming still verified");
  }
}

if (import.meta.main) {
  const accessToken = await resolveCredentialSource();
  const selection = await pickGrokModel(accessToken);
  await buildDist();
  await runPi(selection);
  console.log("smoke-pi-grok: ok");
}
