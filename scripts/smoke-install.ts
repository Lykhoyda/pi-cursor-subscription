import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getCursorAccessTokenFromEnv } from "../src/auth/oauth.js";
import { augmentCursorModels } from "../src/models/parameterized.js";
import { processModels } from "../src/models/processing.js";
import { discoverCursorCatalog } from "../src/stream/model-discovery.js";
import { ThinkingLevel } from "../src/types/enums.js";
import { redactSecrets } from "../src/utils/security.js";
import { locatePi, parseJsonLines, run, checkPiPrintOutcome } from "./smoke-pi-grok.js";

const PACKAGE = "@lykhoyda/pi-cursor-subscription";
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const RPC_ID = "smoke-install";
const SESSION_ARGS = [
  "--no-approve",
  "--no-session",
  "--no-tools",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-themes",
];
const PROMPT = "Reply with exactly one word: pong";
const TAIL_LINES = 20;
const TAIL_LINE_CHARS = 400;
type Stage = "install" | "list" | "load" | "live turn";

interface CommandResponse {
  id?: string;
  type?: string;
  command?: string;
  success?: boolean;
  data?: {
    commands?: Array<{
      name?: string;
      source?: string;
      sourceInfo?: { origin?: string; source?: string; baseDir?: string };
    }>;
  };
}

async function artifactSpec(input: string) {
  if (VERSION.test(input)) {
    return {
      source: `npm:${PACKAGE}@${input}`,
      version: input,
      identity: input,
      tarball: undefined,
    };
  }
  if (!input.endsWith(".tgz"))
    throw new Error("provide an exact published version or a local .tgz file");
  const tarball = resolve(input);
  const digest = createHash("sha256")
    .update(await Bun.file(tarball).bytes())
    .digest("hex");
  return {
    source: `npm:${PACKAGE}@file:${tarball}`,
    identity: `${basename(tarball)} sha256=${digest}`,
    version: undefined,
    tarball,
  };
}

async function smoke(input: string): Promise<number> {
  const pi = locatePi();
  const accessToken = getCursorAccessTokenFromEnv();
  const scrub = (text: string) =>
    redactSecrets(accessToken ? text.replaceAll(accessToken, "[redacted]") : text);
  const report = (line: string) => console.log(scrub(line));
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-cursor-install-")));
  const verdicts: Record<Stage, string> = {
    install: "NOT RUN",
    list: "NOT RUN",
    load: "NOT RUN",
    "live turn": "NOT RUN (package checks did not complete)",
  };
  let stage: Stage = "install";
  let lastOutput = "";
  try {
    const artifact = await artifactSpec(input);
    report(`artifact: ${artifact.identity}`);
    const cwd = join(sandbox, "work");
    mkdirSync(cwd);
    const temporary = join(sandbox, "tmp");
    mkdirSync(temporary);
    const agentDir = join(sandbox, "agent");
    const lifecycle = join(sandbox, "lifecycle.jsonl");
    const env = {
      ...process.env,
      CURSOR_ACCESS_TOKEN: "",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(sandbox, "sessions"),
      PI_CURSOR_SYSTEM_CREDENTIALS: "0",
      PI_CURSOR_NATIVE_EXEC: "0",
      PI_CURSOR_HOSTED_WEB: "0",
      PI_CURSOR_RAW_MODELS: "",
      PI_CURSOR_PROVIDER_DEBUG: "0",
      CURSOR_DEBUG: "0",
      PI_CURSOR_CACHE_DIR: join(sandbox, "cursor-cache"),
      PI_CURSOR_LIFECYCLE_LOG: lifecycle,
      XDG_CACHE_HOME: join(sandbox, "cache"),
      XDG_CONFIG_HOME: join(sandbox, "config"),
      XDG_DATA_HOME: join(sandbox, "data"),
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      npm_config_cache: join(sandbox, "npm-cache"),
      npm_config_prefix: join(sandbox, "npm-global"),
      npm_config_userconfig: join(sandbox, "npm-userconfig"),
      npm_config_globalconfig: join(sandbox, "npm-globalconfig"),
      npm_config_ignore_scripts: "true",
      FORCE_COLOR: "0",
    };
    const hideTarball = (text: string) =>
      artifact.tarball ? text.replaceAll(artifact.tarball, "<tarball>") : text;
    async function runPi(
      args: string[],
      options?: { input?: string; live?: boolean; timeoutMs?: number },
    ) {
      const shown = args.map(hideTarball);
      report(`  pi ${shown.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`);
      const result = await run(pi, args, options?.timeoutMs ?? 30_000, {
        cwd,
        env: options?.live ? { ...env, CURSOR_ACCESS_TOKEN: accessToken, PI_OFFLINE: "" } : env,
        input: options?.input,
      });
      lastOutput = scrub(hideTarball(`${result.stdout}\n${result.stderr}`.trim()));
      return result;
    }
    function requireSuccess(result: Awaited<ReturnType<typeof run>>) {
      if (result.timedOut) throw new Error("Pi timed out");
      if (result.code !== 0) throw new Error(`Pi exited with code ${result.code}`);
    }
    const piVersion = await runPi(["--version"]);
    requireSuccess(piVersion);
    const versionText = piVersion.stdout.trim();
    report(`Pi version: ${VERSION.test(versionText) ? versionText : "unknown"}`);

    requireSuccess(await runPi(["install", artifact.source], { timeoutMs: 120_000 }));
    const packageDir = join(agentDir, "npm", "node_modules", PACKAGE);
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    if (
      manifest.name !== PACKAGE ||
      !manifest.version ||
      !VERSION.test(manifest.version) ||
      (artifact.version && manifest.version !== artifact.version)
    ) {
      throw new Error("installed manifest does not identify the requested package version");
    }
    report(`package: ${PACKAGE}@${manifest.version}`);
    verdicts.install = "PASS";

    stage = "list";
    const listed = await runPi(["list"]);
    requireSuccess(listed);
    const lines = listed.stdout.split("\n").map((line) => line.trim());
    if (!lines.includes(artifact.source) || !lines.includes(packageDir)) {
      throw new Error("pi list did not show the requested source and scratch installation");
    }
    verdicts.list = "PASS";

    stage = "load";
    const inputLine = JSON.stringify({ type: "get_commands", id: RPC_ID });
    report(`  RPC input: ${inputLine}`);
    const loaded = await runPi([...SESSION_ARGS, "--mode", "rpc"], { input: `${inputLine}\n` });
    requireSuccess(loaded);
    const response = parseJsonLines<CommandResponse>(loaded.stdout).events.find(
      (event) =>
        event?.type === "response" && event.id === RPC_ID && event.command === "get_commands",
    );
    const commands = response?.success && response.data?.commands;
    if (
      !commands ||
      !commands.some(
        (command) =>
          command.name === "cursor.doctor" &&
          command.source === "extension" &&
          command.sourceInfo?.origin === "package" &&
          command.sourceInfo.source === artifact.source &&
          command.sourceInfo.baseDir === packageDir,
      )
    ) {
      throw new Error("Pi did not register /cursor.doctor from the installed package");
    }
    verdicts.load = "PASS";

    stage = "live turn";
    const modelId = process.env.CURSOR_SMOKE_INCLUDED_MODEL?.trim();
    const thinking = Object.values(ThinkingLevel).find(
      (level) => level === (process.env.CURSOR_SMOKE_THINKING?.trim() || ThinkingLevel.Low),
    );
    const skip = (reason: string) => {
      verdicts["live turn"] = `NOT RUN (${reason})`;
      return 3;
    };
    if (!modelId) return skip("no included route confirmed via CURSOR_SMOKE_INCLUDED_MODEL");
    if (!MODEL_ID.test(modelId) || !thinking)
      return skip("invalid included model id or thinking level");
    report(`model: cursor/${modelId} thinking=${thinking}`);
    if (!accessToken) return skip("CURSOR_ACCESS_TOKEN is unavailable for the confirmed route");

    // Prime the scratch catalog before Pi starts. The installed extension needs
    // online mode to load this cache and register the newly discovered models.
    process.env.PI_CURSOR_CACHE_DIR = env.PI_CURSOR_CACHE_DIR;
    const catalog = await discoverCursorCatalog(accessToken, {
      signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined);
    if (!catalog || (!catalog.rawModels.length && !catalog.parameterizedModels.length)) {
      return skip("live Cursor catalog discovery returned no models");
    }
    const model = processModels(
      augmentCursorModels(catalog.rawModels, catalog.parameterizedModels),
    ).find((candidate) => candidate.id === modelId);
    if (!model) return skip("the confirmed model is absent from the live Cursor catalog");
    if (model.supportsEffort && !model.effortMap?.[thinking]) {
      return skip("the confirmed thinking level is absent from the live Cursor catalog");
    }
    const models = await runPi([...SESSION_ARGS, "--list-models", modelId], { live: true });
    requireSuccess(models);
    if (
      !models.stdout.split("\n").some((line) => {
        const [provider, id] = line.trim().split(/\s+/);
        return provider === "cursor" && id === modelId;
      })
    ) {
      throw new Error("the installed extension did not list the exact confirmed Cursor model");
    }

    const turn = await runPi(
      [
        ...SESSION_ARGS,
        "--print",
        "--mode",
        "json",
        "--provider",
        "cursor",
        "--model",
        modelId,
        "--thinking",
        thinking,
        "--system-prompt",
        "You are a smoke test assistant.",
        PROMPT,
      ],
      { live: true, timeoutMs: 120_000 },
    );
    const lifecycleText = await Bun.file(lifecycle)
      .text()
      .catch(() => "");
    const outcome = checkPiPrintOutcome(turn, lifecycleText, { modelId, timeoutMs: 120_000 });
    if (outcome.code === 1) throw new Error(outcome.reason);
    report(`lifecycle: streams=${outcome.streams} all closed`);
    if (outcome.code === 3) return skip(`Cursor usage refused (${outcome.refusal})`);
    const { deltaCount } = outcome.summary;
    const routes = parseJsonLines<{ event?: string; modelId?: string }>(lifecycleText)
      .events.filter(
        (event) => event?.event === "request_size" && event.modelId && MODEL_ID.test(event.modelId),
      )
      .map((event) => event.modelId);
    report(
      `reply: provider=cursor api=cursor-native model=${modelId} routes=${[...new Set(routes)].join(",")} text_deltas=${deltaCount}`,
    );
    verdicts["live turn"] = "PASS";
    return 0;
  } catch (error) {
    if (lastOutput) {
      report("  last Pi output:");
      for (const line of lastOutput.split("\n").slice(-TAIL_LINES)) {
        report(
          `  | ${line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}…` : line}`,
        );
      }
    }
    verdicts[stage] = `FAIL (${error instanceof Error ? error.message : String(error)})`;
    return 1;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
    for (const [step, verdict] of Object.entries(verdicts)) report(`${step}: ${verdict}`);
  }
}

if (process.argv.length !== 3 || process.argv[2] === "--help") {
  console.log("Usage: bun run smoke:install -- <published-version | release.tgz>");
  process.exitCode = process.argv[2] === "--help" ? 0 : 1;
} else {
  process.exitCode = await smoke(process.argv[2]!);
}
