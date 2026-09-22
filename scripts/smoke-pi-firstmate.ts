/**
 * Live smoke: Pi + this Cursor provider + a Firstmate checkout's watcher extension.
 *
 * Proves a Pi 0.86 transcript still delivers `bash` and `fm_watch_arm_pi` on the
 * Cursor request. The Firstmate repo is not the session home: FM_HOME is a temp
 * dir, so session_start cannot write state into that checkout or arm its watcher.
 *
 * Usage: bun run smoke:pi-firstmate
 *
 * CURSOR_SMOKE_FIRSTMATE  checkout containing .pi/extensions/fm-primary-pi-watch.ts
 * CURSOR_SMOKE_MODEL / CURSOR_SMOKE_THINKING / CURSOR_SMOKE_PROMPT /
 * CURSOR_SMOKE_TIMEOUT_MS / PI_BIN — same as smoke:pi-grok
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIST_ENTRY,
  type Selection,
  buildDist,
  fail,
  locatePi,
  log,
  parseJsonLines,
  setLogPrefix,
  pickGrokModel,
  resolveCredentialSource,
  run,
  summarizeAssistant,
} from "./smoke-pi-grok.ts";

const WATCH_EXTENSION = ".pi/extensions/fm-primary-pi-watch.ts";
const REQUIRED_TOOLS = ["bash", "fm_watch_arm_pi"] as const;
const DEFAULT_PROMPT = "Reply with exactly one word: pong. Do not call any tools.";
const DEFAULT_TIMEOUT_MS = 180_000;

class SmokeFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly details?: string,
  ) {
    super(message);
  }
}

function firstmateRoot(): string {
  const candidate = process.env.CURSOR_SMOKE_FIRSTMATE?.trim();
  if (!candidate || !existsSync(join(candidate, WATCH_EXTENSION))) {
    fail(
      "firstmate",
      "Set CURSOR_SMOKE_FIRSTMATE to a repo that contains .pi/extensions/fm-primary-pi-watch.ts",
      candidate,
    );
  }
  return candidate;
}

function toolNamesFromLifecycle(path: string): string[] {
  if (!existsSync(path)) return [];
  const names = new Set<string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as { event?: string; toolNames?: unknown };
      if (event.event !== "request_size" || !Array.isArray(event.toolNames)) continue;
      for (const name of event.toolNames) if (typeof name === "string") names.add(name);
    } catch {
      // A torn final line is not a tool list.
    }
  }
  return [...names];
}

async function runPi(selection: Selection, project: string): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-cursor-firstmate-"));
  const lifecycleLog = join(sandbox, "lifecycle.jsonl");
  const prompt = process.env.CURSOR_SMOKE_PROMPT?.trim() || DEFAULT_PROMPT;
  const timeoutMs = Number(process.env.CURSOR_SMOKE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  log("firstmate", `project=${project}`);
  log("pi", `prompt="${prompt}" timeout=${timeoutMs}ms`);
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
    "--approve",
    "--extension",
    DIST_ENTRY,
    "--extension",
    join(project, WATCH_EXTENSION),
    "--tools",
    REQUIRED_TOOLS.join(","),
    "--provider",
    "cursor",
    "--model",
    selection.model.id,
    "--thinking",
    selection.thinking,
    prompt,
  ];
  const env = {
    ...process.env,
    PI_CURSOR_LIFECYCLE_LOG: lifecycleLog,
    FM_HOME: sandbox,
    FM_ROOT_OVERRIDE: sandbox,
    FM_STATE_OVERRIDE: join(sandbox, "state"),
    FM_CONFIG_OVERRIDE: join(sandbox, "config"),
  };
  try {
    const startedAt = Date.now();
    const result = await run(locatePi(), args, timeoutMs, { cwd: sandbox, env });
    const names = toolNamesFromLifecycle(lifecycleLog);
    const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      throw new SmokeFailure(
        "tools",
        `Cursor request missing ${missing.join(", ")}`,
        `toolNames=${names.join(", ") || "(none)"}\n${result.stderr}\n${result.stdout}`,
      );
    }
    log("tools", names.join(", "));
    if (result.timedOut) throw new SmokeFailure("pi", `no completion within ${timeoutMs}ms`, result.stderr);
    if (result.code !== 0) {
      throw new SmokeFailure("pi", `exited with code ${result.code}`, `${result.stderr}\n${result.stdout}`);
    }
    const { events, nonJson } = parseJsonLines(result.stdout);
    const summary = summarizeAssistant(events);
    if (summary.errorEvents.length > 0) {
      throw new SmokeFailure("stream", "pi reported error events", JSON.stringify(summary.errorEvents, null, 2));
    }
    if (!summary.finalMessage) {
      throw new SmokeFailure(
        "stream",
        "no assistant message_end in pi output",
        `${result.stderr}\n${nonJson.join("\n")}`,
      );
    }
    const { provider, api, model: reportedModel, stopReason, usage } = summary.finalMessage;
    if (provider !== "cursor" || api !== "cursor-native") {
      throw new SmokeFailure(
        "stream",
        `reply did not come through this provider (provider=${provider} api=${api})`,
      );
    }
    if (reportedModel !== selection.model.id) {
      throw new SmokeFailure("stream", `reply model mismatch: expected ${selection.model.id}, got ${reportedModel}`);
    }
    if (stopReason !== "stop") {
      throw new SmokeFailure(
        "stream",
        `assistant stopReason=${stopReason}`,
        summary.finalMessage.errorMessage ?? "",
      );
    }
    if (!summary.finalText.trim()) throw new SmokeFailure("stream", "assistant reply text is empty");
    log(
      "stream",
      `elapsed=${Date.now() - startedAt}ms usage(in=${usage?.input ?? "?"} out=${usage?.output ?? "?"})`,
    );
    log("reply", `"${summary.finalText.replace(/\s+/g, " ").trim().slice(0, 200)}"`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

setLogPrefix("smoke-pi-firstmate");

try {
  const project = firstmateRoot();
  const accessToken = await resolveCredentialSource();
  const selection = await pickGrokModel(accessToken);
  await buildDist();
  await runPi(selection, project);
  console.log("smoke-pi-firstmate: ok");
} catch (error) {
  if (error instanceof SmokeFailure) fail(error.step, error.message, error.details);
  throw error;
}
