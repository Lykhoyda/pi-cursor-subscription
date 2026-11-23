import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyLeg } from "../scripts/smoke-gate.js";
import { checkPiPrintOutcome, parseJsonLines } from "../scripts/smoke-pi-grok.js";
import { frameConnectMessage } from "../src/client/bridge.js";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  type InteractionUpdate,
} from "../src/proto/agent_pb.js";
import { bridgeCloseGaps } from "../src/stream/debug-log.js";
import { ConnectFlag } from "../src/types/enums.js";

const ROOT = resolve(import.meta.dir, "..");
const MODEL = "composer-2";
const STARTUP_MS = 15_000;
const SETTLED_MS = 8_000;
const PEERS = ["0.86.1", "1.3.0"] as const;
const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
let fixture = "";

function hostRoot(entry: string) {
  return resolve(dirname(fileURLToPath(entry)), "..");
}

beforeAll(() => {
  const build = spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);

  fixture = mkdtempSync(join(tmpdir(), "pi-print-lifecycle-"));
  mkdirSync(join(fixture, "peers"));
  for (const file of ["package.json", "bun.lock"]) {
    copyFileSync(join(import.meta.dir, "fixtures", "pi-hosts", file), join(fixture, "peers", file));
  }
  const install = spawnSync(
    process.execPath,
    ["install", "--frozen-lockfile", "--ignore-scripts", "--no-progress"],
    { cwd: join(fixture, "peers"), encoding: "utf8", timeout: 60_000 },
  );
  expect(install.status, install.stderr).toBe(0);

  // Let the running Pi supply its peer APIs, as in a normal installed package.
  const extension = join(fixture, "extension");
  mkdirSync(join(extension, "node_modules", "@bufbuild"), { recursive: true });
  writeFileSync(join(extension, "package.json"), '{"type":"module"}');
  copyFileSync(join(ROOT, "dist", "index.js"), join(extension, "index.js"));
  symlinkSync(
    join(ROOT, "node_modules", "@bufbuild", "protobuf"),
    join(extension, "node_modules", "@bufbuild", "protobuf"),
  );
}, 90_000);

afterAll(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

type Mode = "success" | "refusal" | "429" | "silence" | "unrelated" | "retry-success";
interface TurnOptions {
  mode: Mode;
  peer?: (typeof PEERS)[number];
  providerRetries?: number;
  disablePiRetries?: boolean;
  shutdown?: "leak" | "host-failure";
}
interface PiLine {
  type?: string;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    api?: string;
    stopReason?: string;
    errorMessage?: string;
  };
}

function updateFrame(message: InteractionUpdate["message"]) {
  return frameConnectMessage(
    toBinary(
      AgentServerMessageSchema,
      create(AgentServerMessageSchema, {
        message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
      }),
    ),
  );
}

const SUCCESS = Buffer.concat([
  updateFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "pong" }) }),
  updateFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) }),
  frameConnectMessage(Buffer.from("{}"), ConnectFlag.EndStream),
]);

async function runTurn(options: TurnOptions) {
  const { mode, peer, shutdown } = options;
  const sandbox = mkdtempSync(join(fixture, "turn-"));
  const agentDir = join(sandbox, "agent");
  mkdirSync(agentDir);
  if (options.disablePiRetries) {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  }
  const host = peer
    ? hostRoot(import.meta.resolve(`pi-${peer}`, join(fixture, "peers", "package.json")))
    : hostRoot(import.meta.resolve(PACKAGE_NAME));
  const { version } = JSON.parse(readFileSync(join(host, "package.json"), "utf8"));

  const shutdownArgs: string[] = [];
  if (shutdown) {
    const hook = join(sandbox, "shutdown.mjs");
    const action =
      shutdown === "leak"
        ? "setInterval(() => {}, 60_000);"
        : 'console.error("independent fixture host failure"); process.once("beforeExit", () => { process.exitCode = 1; });';
    writeFileSync(hook, `export default (pi) => pi.on("session_shutdown", () => { ${action} });\n`);
    shutdownArgs.push("--extension", hook);
  }

  let requests = 0;
  let opened = 0;
  let closed = 0;
  const sessions = new Set<ServerHttp2Session>();
  const counts = () => ({ requests, opened, closed, live: sessions.size });
  const server = createServer();
  server.on("session", (session) => {
    opened++;
    sessions.add(session);
    session.on("close", () => {
      closed++;
      sessions.delete(session);
    });
    session.on("error", () => {});
  });

  let deadline: ReturnType<typeof setTimeout> | undefined;
  let beforeKill: ReturnType<typeof counts> | undefined;
  let stopChild: (() => void) | undefined;
  try {
    server.on("stream", (incoming, headers) => {
      const stream = incoming as ServerHttp2Stream;
      stream.on("error", () => {});
      if (headers[":path"] !== "/agent.v1.AgentService/Run") {
        stream.respond({ ":status": 404 });
        stream.end();
        return;
      }
      const attempt = ++requests;
      stream.once("data", () => {
        if (mode === "silence") return;
        if (mode === "429") {
          stream.respond({ ":status": 429 });
          stream.end("fixture rate limit");
          return;
        }
        stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
        if (mode === "success" || (mode === "retry-success" && attempt > 1)) {
          stream.end(SUCCESS);
        } else {
          const code = mode === "unrelated" ? "invalid_argument" : "resource_exhausted";
          const body = Buffer.from(JSON.stringify({ error: { code, message: "fixture error" } }));
          stream.end(frameConnectMessage(body, ConnectFlag.EndStream));
        }
      });
      stream.resume();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const lifecyclePath = join(sandbox, "lifecycle.jsonl");
    const child = spawn(
      process.execPath,
      [
        join(host, "dist", "bundle", "cli.js"),
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
        join(fixture, "extension", "index.js"),
        ...shutdownArgs,
        "--provider",
        "cursor",
        "--model",
        MODEL,
        "--thinking",
        "off",
        "Reply with pong",
      ],
      {
        cwd: sandbox,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
          PI_CURSOR_CACHE_DIR: join(sandbox, "cache"),
          PI_CURSOR_LIFECYCLE_LOG: lifecyclePath,
          PI_CURSOR_AGENT_URL: `http://127.0.0.1:${port}`,
          CURSOR_ACCESS_TOKEN: "synthetic-fixture-value",
          PI_CURSOR_SYSTEM_CREDENTIALS: "0",
          PI_CURSOR_NATIVE_EXEC: "0",
          PI_CURSOR_HOSTED_WEB: "0",
          PI_CURSOR_STREAM_IDLE_MAX_RETRIES: options.providerRetries?.toString(),
        },
      },
    );
    stopChild = () => {
      child.kill("SIGKILL");
    };
    const killAtDeadline = () => {
      beforeKill = counts();
      stopChild?.();
      // A descendant can keep a pipe open even after Pi exits.
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const initialMs = mode === "429" && !options.disablePiRetries ? 35_000 : STARTUP_MS;
    deadline = setTimeout(killAtDeadline, initialMs);

    let stdout = "";
    let stderr = "";
    let parsedThrough = 0;
    let settledAt: number | undefined;
    let latestAssistant: PiLine["message"];
    let settledAssistant: PiLine["message"];
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      const end = stdout.lastIndexOf("\n") + 1;
      if (end <= parsedThrough) return;
      for (const event of parseJsonLines<PiLine>(stdout.slice(parsedThrough, end)).events) {
        if (event.type === "message_end" && event.message?.role === "assistant") {
          latestAssistant = event.message;
        } else if (event.type === "agent_settled") {
          settledAt = performance.now();
          settledAssistant = latestAssistant;
          clearTimeout(deadline);
          deadline = setTimeout(killAtDeadline, SETTLED_MS);
        }
      }
      parsedThrough = end;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.stdin.end();

    let exit:
      | {
          code: number | null;
          signal: NodeJS.Signals | null;
          time: number;
          counts: ReturnType<typeof counts>;
        }
      | undefined;
    child.on("exit", (code, signal) => {
      exit = { code, signal, time: performance.now(), counts: counts() };
    });
    const [code, signal] = await once(child, "close");
    stopChild = undefined;
    clearTimeout(deadline);

    const lifecycle = await Bun.file(lifecyclePath)
      .text()
      .catch(() => "");
    const events = parseJsonLines<PiLine>(stdout).events;
    const final = events
      .slice()
      .reverse()
      .find(
        (event) => event.type === "message_end" && event.message?.role === "assistant",
      )?.message;
    const outcome = checkPiPrintOutcome(
      { code, signal, stdout, stderr, timedOut: beforeKill !== undefined },
      lifecycle,
      { modelId: MODEL, timeoutMs: settledAt ? SETTLED_MS : initialMs },
    );
    const piRetries = events.filter((event) => event.type === "auto_retry_start").length;
    const piRetryEnds = events.filter((event) => event.type === "auto_retry_end").length;
    const bridges = parseJsonLines<{ event: string; bridgeId: number }>(lifecycle).events;
    const starts = bridges
      .filter(({ event }) => event === "stream_start")
      .map(({ bridgeId }) => bridgeId);
    const closes = bridges
      .filter(({ event }) => event === "bridge_close")
      .map(({ bridgeId }) => bridgeId);
    if (process.env.PI_CURSOR_TEST_LIFECYCLE_EVIDENCE === "1") {
      console.log(
        JSON.stringify({
          mode,
          shutdown,
          version,
          model: MODEL,
          stopReason: final?.stopReason,
          api: final?.api,
          refusal: final?.errorMessage?.match(/^Connect error ([^:]+):/)?.[1],
          settled: settledAt !== undefined,
          code,
          signal,
          beforeKill,
          afterSettledMs: exit && settledAt ? Math.round(exit.time - settledAt) : undefined,
          atExit: exit?.counts,
          starts,
          closes,
          piRetries,
          piRetryEnds,
          wrapperCode: outcome.code,
        }),
      );
    }
    return {
      outcome,
      final,
      settledAssistant,
      settledAt,
      exit,
      beforeKill,
      lifecycle,
      starts,
      closes,
      piRetries,
      piRetryEnds,
      version,
    };
  } finally {
    clearTimeout(deadline);
    stopChild?.();
    for (const session of sessions) session.destroy();
    server.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function expectNaturalExit(turn: Awaited<ReturnType<typeof runTurn>>, bridges: number) {
  expect(turn.beforeKill).toBeUndefined();
  expect(turn.exit).toMatchObject({
    code: 0,
    signal: null,
    counts: { requests: bridges, opened: bridges, closed: bridges, live: 0 },
  });
  if (turn.settledAt !== undefined) {
    const afterSettledMs = turn.exit!.time - turn.settledAt;
    expect(afterSettledMs).toBeGreaterThanOrEqual(0);
    expect(afterSettledMs).toBeLessThan(SETTLED_MS);
  }
  expect(turn.starts).toHaveLength(bridges);
  expect(new Set(turn.starts).size).toBe(bridges);
  expect([...turn.closes].sort()).toEqual([...turn.starts].sort());
  expect(bridgeCloseGaps(turn.lifecycle)).toEqual({ started: bridges, open: [] });
}

describe("real Pi print over loopback HTTP/2", () => {
  it.each([
    { mode: "refusal", code: 3, bridges: 6 },
    { mode: "refusal", code: 3, bridges: 1, providerRetries: 0 },
    { mode: "429", code: 3, bridges: 6, disablePiRetries: true },
    { mode: "success", code: 0, bridges: 1 },
    { mode: "retry-success", code: 0, bridges: 2 },
    { mode: "unrelated", code: 1, bridges: 1 },
  ] as const)(
    "settles and exits for %j",
    async ({ code, bridges, ...options }) => {
      const turn = await runTurn(options);
      expect(turn.settledAt).toBeDefined();
      expect(turn.settledAssistant).toEqual(turn.final);
      expect(turn.final).toMatchObject({ provider: "cursor", api: "cursor-native", model: MODEL });
      expect(turn.piRetries).toBe(0);
      expect(turn.piRetryEnds).toBe(0);
      expectNaturalExit(turn, bridges);
      expect(turn.outcome.code).toBe(code);
      if (code === 3) {
        expect(turn.outcome).toMatchObject({
          refusal: options.mode === "429" ? "http_429" : "resource_exhausted",
        });
      }
    },
    30_000,
  );

  it("fails when the server stays silent", async () => {
    const turn = await runTurn({ mode: "silence" });
    expect(turn.settledAt).toBeUndefined();
    expect(turn.beforeKill).toEqual({ requests: 1, opened: 1, closed: 0, live: 1 });
    expect(turn.exit?.signal).toBe("SIGKILL");
    expect(turn.outcome).toMatchObject({
      code: 1,
      reason: expect.stringContaining("no completion within"),
    });
  }, 30_000);

  it("fails if a referenced handle keeps Pi alive after every bridge closes", async () => {
    const turn = await runTurn({ mode: "refusal", shutdown: "leak" });
    expect(turn.settledAt).toBeDefined();
    expect(turn.final?.errorMessage).toStartWith("Connect error resource_exhausted:");
    expect(turn.beforeKill).toEqual({ requests: 6, opened: 6, closed: 6, live: 0 });
    expect(turn.exit?.signal).toBe("SIGKILL");
    expect(bridgeCloseGaps(turn.lifecycle)).toEqual({ started: 6, open: [] });
    expect(turn.outcome).toMatchObject({
      code: 1,
      reason: expect.stringContaining("Cursor usage refused: resource_exhausted"),
    });
  }, 30_000);

  it("fails on an independent JSON host exit 1 after a settled and closed refusal", async () => {
    const turn = await runTurn({ mode: "refusal", shutdown: "host-failure" });
    expect(turn.settledAt).toBeDefined();
    expect(turn.beforeKill).toBeUndefined();
    expect(turn.exit).toMatchObject({
      code: 1,
      signal: null,
      counts: { requests: 6, opened: 6, closed: 6, live: 0 },
    });
    expect(bridgeCloseGaps(turn.lifecycle)).toEqual({ started: 6, open: [] });
    expect(turn.outcome).toMatchObject({
      code: 1,
      reason: "exited with code 1 (Cursor usage refused: resource_exhausted)",
    });
    expect(
      classifyLeg({
        name: "pi-grok",
        code: turn.outcome.code,
        stdout: "",
        stderr: turn.outcome.code === 1 ? turn.outcome.reason : "",
        timedOut: false,
        deadlineMs: 240_000,
      }).status,
    ).toBe("FAIL");
  }, 30_000);

  it.each([...PEERS])(
    "closes and exits on a typed refusal in Pi %s",
    async (peer) => {
      const turn = await runTurn({ mode: "refusal", peer });
      expect(turn.version).toBe(peer);
      expect(turn.outcome).toMatchObject({ code: 3, refusal: "resource_exhausted" });
      expectNaturalExit(turn, 6);
    },
    30_000,
  );

  if (process.env.PI_CURSOR_TEST_429_AUTO_RETRY === "1") {
    it("tracks Pi auto-retries separately from provider attempts on HTTP 429", async () => {
      const turn = await runTurn({ mode: "429" });
      expect(turn.piRetries).toBe(3);
      expect(turn.piRetryEnds).toBe(1);
      expect(turn.settledAt).toBeDefined();
      expect(turn.outcome).toMatchObject({ code: 3, refusal: "http_429" });
      expectNaturalExit(turn, 24);
    }, 50_000);
  }
});
