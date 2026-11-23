/**
 * Live end-to-end smoke: Pi Coding Agent + this package as the Cursor provider + Grok.
 *
 * Proves the whole path a user exercises — `pi` loads `dist/index.js`, the extension
 * registers the `cursor` provider, `--model` resolves to a real Cursor Grok variant
 * (4.7 when the account lists it, otherwise 4.6), and a trivial prompt streams a
 * non-empty reply back through pi's JSON event stream. The lifecycle log must show
 * every physical bridge close.
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getStartupCursorAccessToken } from "../src/extension/auth.js";
import { augmentCursorModels } from "../src/models/parameterized.js";
import { processModels, type ProcessedModel } from "../src/models/processing.js";
import { ExecServerMessageSchema } from "../src/proto/agent_pb.js";
import { bridgeCloseGaps } from "../src/stream/debug-log.js";
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
  signal: NodeJS.Signals | null;
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
  assistantMessageEvent?: { type: string; delta?: string; error?: PiAssistantMessage };
  message?: PiAssistantMessage;
  errorMessage?: string;
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

  const thinking = (process.env.CURSOR_SMOKE_THINKING?.trim() ||
    DEFAULT_THINKING) as PiThinkingLevel;
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
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options?.cwd ?? ROOT,
      env: options?.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnFailed = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        }, timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
    child.stderr.setEncoding("utf8").on("data", (data: string) => (stderr += data));
    // The child can exit before reading the optional RPC request.
    child.stdin.on("error", () => {});
    child.stdin.end(options?.input);
    child.on("error", (error) => {
      spawnFailed = true;
      stderr += `\n${error.message}`;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: spawnFailed ? -1 : code, signal, stdout, stderr, timedOut });
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

export function parseJsonLines<T = PiEvent>(stdout: string): { events: T[]; nonJson: string[] } {
  const events: T[] = [];
  const nonJson: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as T);
    } catch {
      nonJson.push(trimmed);
    }
  }
  return { events, nonJson };
}

function summarizeAssistant(events: PiEvent[], modelId: string) {
  let pendingDeltas = 0;
  let pendingText = "";
  let deltaCount = 0;
  let streamed = "";
  let settled = false;
  const errorEvents: Array<{ message?: string; assistant?: PiAssistantMessage }> = [];
  const refusedMessages = new Set<string>();
  let finalMessage: PiAssistantMessage | undefined;

  for (const event of events) {
    if (!event) continue;
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        pendingDeltas++;
        pendingText += inner.delta;
      }
      if (inner?.type === "error") {
        errorEvents.push({ message: inner.error?.errorMessage, assistant: inner.error });
      }
    }
    if (event.type === "error") errorEvents.push({ message: event.errorMessage });
    if (event.type === "message_end" && event.message?.role === "assistant") {
      finalMessage = event.message;
      deltaCount = pendingDeltas;
      streamed = pendingText;
      pendingDeltas = 0;
      pendingText = "";
      settled = false;
      if (finalMessage.errorMessage && usageRefusal(finalMessage, modelId)) {
        refusedMessages.add(finalMessage.errorMessage);
      }
    }
    if (event.type === "agent_settled") settled = true;
  }

  const content = finalMessage?.content;
  const finalText = (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");

  const unrelatedError = errorEvents.some(
    ({ message, assistant }) =>
      !message || !refusedMessages.has(message) || (assistant && !usageRefusal(assistant, modelId)),
  );
  return { deltaCount, streamed, finalText, finalMessage, settled, unrelatedError };
}

type UsageRefusalCode = "resource_exhausted" | "http_429";

function usageRefusal(message: PiAssistantMessage | undefined, modelId: string) {
  if (
    message?.role !== "assistant" ||
    message.provider !== "cursor" ||
    message.api !== "cursor-native" ||
    message.model !== modelId ||
    message.stopReason !== "error" ||
    typeof message.errorMessage !== "string"
  ) {
    return undefined;
  }
  const code = /^Connect error (resource_exhausted|http_429):/.exec(message.errorMessage)?.[1];
  return code as UsageRefusalCode | undefined;
}

function knownExecCase(value: unknown): string | undefined {
  // Case names come from the compiled oneof. Never echo arbitrary log text.
  return ExecServerMessageSchema.fields.find(
    (field) => field.oneof?.name === "message" && field.localName === value,
  )?.localName;
}

export function unhandledExecDiagnostic(lifecycleText: string, stderr: string): string | undefined {
  const warning = /^(?:\[cursor-provider\] )?UNHANDLED exec case\b(?:: "([^"\r\n]*)")?/m.exec(
    `${stderr}\n${lifecycleText}`,
  );
  const warningCase = knownExecCase(warning?.[1]);
  for (const line of lifecycleText.split("\n")) {
    if (!line.includes('"exec_unknown_shape"')) continue;
    try {
      const event = JSON.parse(line) as {
        event?: string;
        execCase?: unknown;
        unknownFields?: unknown;
      } | null;
      if (event?.event !== "exec_unknown_shape") continue;
      const execCase = knownExecCase(event.execCase) ?? warningCase;
      if (execCase) return `UNHANDLED exec case: ${execCase}`;
      const field =
        typeof event.unknownFields === "string"
          ? /^([1-9]\d{0,8}):wt[0-5]:\d+b(?:,|$)/.exec(event.unknownFields)?.[1]
          : undefined;
      return `UNHANDLED exec case: ${field ? `protobuf field ${field}` : "unknown"}`;
    } catch {
      // Ignore incomplete JSONL records.
    }
  }
  if (warning) return `UNHANDLED exec case: ${warningCase ?? "unknown"}`;
  return undefined;
}

type PrintOutcome =
  | { code: 1; step: string; reason: string; details?: string }
  | { code: 3; refusal: UsageRefusalCode; streams: number }
  | { code: 0; summary: ReturnType<typeof summarizeAssistant>; streams: number };

export function checkPiPrintOutcome(
  result: RunResult,
  lifecycleText: string,
  options: { modelId: string; timeoutMs: number; missingTools?: readonly string[] },
): PrintOutcome {
  const { events, nonJson } = parseJsonLines(result.stdout);
  const summary = summarizeAssistant(events, options.modelId);
  const message = summary.finalMessage;
  const refusal = usageRefusal(message, options.modelId);
  const refusalContext = refusal ? ` (Cursor usage refused: ${refusal})` : "";
  const failure = (step: string, reason: string, details?: string): PrintOutcome => ({
    code: 1,
    step,
    reason,
    details,
  });
  if (result.timedOut)
    return failure(
      "pi",
      `no completion within ${options.timeoutMs}ms${refusalContext}`,
      result.stderr,
    );
  if (result.signal || result.code !== 0) {
    const exit = result.signal
      ? `terminated by ${result.signal}`
      : `exited with code ${result.code}`;
    return failure("pi", exit + refusalContext, result.stderr);
  }
  const execDiagnostic = unhandledExecDiagnostic(lifecycleText, result.stderr);
  if (execDiagnostic) return failure("lifecycle", execDiagnostic);
  if (options.missingTools?.length)
    return failure("tools", `Cursor request missing ${options.missingTools.join(", ")}`);
  if (!message) return failure("stream", "no assistant message_end in pi output", result.stderr);
  if (nonJson.some((line) => line.startsWith("{")))
    return failure("stream", "incomplete or invalid Pi JSON event");
  const { provider, api, model, stopReason } = message;
  if (provider !== "cursor" || api !== "cursor-native")
    return failure(
      "stream",
      `reply did not come through this provider (provider=${provider} api=${api})`,
    );
  if (model !== options.modelId)
    return failure("stream", `reply model mismatch: expected ${options.modelId}, got ${model}`);
  if (summary.unrelatedError) return failure("stream", "pi reported unrelated error events");
  if (refusal && !summary.settled)
    return failure("stream", `assistant turn did not settle${refusalContext}`);
  if (!refusal && stopReason !== "stop")
    return failure("stream", `assistant stopReason=${stopReason}`, message.errorMessage);

  const gaps = bridgeCloseGaps(lifecycleText);
  if (!gaps.started) return failure("lifecycle", "no stream_start in the lifecycle log");
  if (gaps.open.length)
    return failure("lifecycle", `bridge never closed for ${gaps.open.join(", ")}${refusalContext}`);
  if (refusal) return { code: 3, refusal, streams: gaps.started };
  if (summary.deltaCount === 0) return failure("stream", "no text_delta events streamed");
  if (!summary.finalText.trim()) return failure("stream", "assistant reply text is empty");
  return { code: 0, summary, streams: gaps.started };
}

export function reportPiPrintOutcome(outcome: PrintOutcome): 0 | 3 {
  if (outcome.code === 1) fail(outcome.step, outcome.reason, outcome.details);
  log("lifecycle", `streams=${outcome.streams} all closed`);
  if (outcome.code === 3) log("NOT RUN pi", `Cursor usage refused (${outcome.refusal})`);
  return outcome.code;
}

export async function runPi({ model, thinking }: Selection): Promise<0 | 3> {
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

  const sandbox = mkdtempSync(join(tmpdir(), "pi-cursor-grok-"));
  const lifecycleLog = join(sandbox, "lifecycle.jsonl");
  const startedAt = Date.now();
  let outcome: PrintOutcome;
  try {
    const result = await run(piBin, args, timeoutMs, {
      env: { ...process.env, PI_CURSOR_LIFECYCLE_LOG: lifecycleLog },
    });
    const lifecycleText = existsSync(lifecycleLog) ? readFileSync(lifecycleLog, "utf8") : "";
    outcome = checkPiPrintOutcome(result, lifecycleText, { modelId: model.id, timeoutMs });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  if (outcome.code === 0) {
    const { finalMessage, finalText, deltaCount, streamed } = outcome.summary;
    const usage = finalMessage?.usage;
    const preview = finalText.replace(/\s+/g, " ").trim().slice(0, REPLY_PREVIEW_CHARS);
    log(
      "stream",
      `text_delta=${deltaCount} streamedChars=${streamed.length} elapsed=${Date.now() - startedAt}ms ` +
        `usage(in=${usage?.input ?? "?"} out=${usage?.output ?? "?"})`,
    );
    log("reply", `"${preview}"`);
    if (!/pong/i.test(finalText)) {
      log("reply", "note: reply did not contain the requested word; streaming still verified");
    }
  }
  return reportPiPrintOutcome(outcome);
}

if (import.meta.main) {
  const accessToken = await resolveCredentialSource();
  const selection = await pickGrokModel(accessToken);
  await buildDist();
  process.exitCode = await runPi(selection);
  if (process.exitCode === 0) console.log("smoke-pi-grok: ok");
}
