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
  checkPiPrintOutcome,
  reportPiPrintOutcome,
  setLogPrefix,
  pickGrokModel,
  resolveCredentialSource,
  run,
} from "./smoke-pi-grok.ts";

const WATCH_EXTENSION = ".pi/extensions/fm-primary-pi-watch.ts";
const REQUIRED_TOOLS = ["bash", "fm_watch_arm_pi"] as const;
const DEFAULT_PROMPT = "Reply with exactly one word: pong. Do not call any tools.";
const DEFAULT_TIMEOUT_MS = 180_000;

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

function toolNamesFromLifecycle(lifecycleText: string): string[] {
  const names = new Set<string>();
  for (const line of lifecycleText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as { event?: string; toolNames?: unknown };
      if (event?.event !== "request_size" || !Array.isArray(event.toolNames)) continue;
      for (const name of event.toolNames) if (typeof name === "string") names.add(name);
    } catch {
      // A torn final line is not a tool list.
    }
  }
  return [...names];
}

async function runPi(selection: Selection, project: string): Promise<0 | 3> {
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
  const startedAt = Date.now();
  let outcome: ReturnType<typeof checkPiPrintOutcome>;
  let names: string[];
  try {
    const result = await run(locatePi(), args, timeoutMs, { cwd: sandbox, env });
    const lifecycleText = existsSync(lifecycleLog) ? readFileSync(lifecycleLog, "utf8") : "";
    names = toolNamesFromLifecycle(lifecycleText);
    outcome = checkPiPrintOutcome(result, lifecycleText, {
      modelId: selection.model.id,
      timeoutMs,
      missingTools: REQUIRED_TOOLS.filter((name) => !names.includes(name)),
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
  if (outcome.code !== 1) log("tools", names.join(", "));
  if (outcome.code === 0) {
    const { finalMessage, finalText } = outcome.summary;
    const usage = finalMessage?.usage;
    log(
      "stream",
      `elapsed=${Date.now() - startedAt}ms usage(in=${usage?.input ?? "?"} out=${usage?.output ?? "?"})`,
    );
    log("reply", `"${finalText.replace(/\s+/g, " ").trim().slice(0, 200)}"`);
  }
  return reportPiPrintOutcome(outcome);
}

if (import.meta.main) {
  setLogPrefix("smoke-pi-firstmate");
  const project = firstmateRoot();
  const accessToken = await resolveCredentialSource();
  const selection = await pickGrokModel(accessToken);
  await buildDist();
  process.exitCode = await runPi(selection, project);
  if (process.exitCode === 0) console.log("smoke-pi-firstmate: ok");
}
