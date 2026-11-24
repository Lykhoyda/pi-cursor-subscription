import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  dispatchNativeExec,
  emptyGrepPatternRejection,
  fetchPublic,
  parseShellEnvExtra,
  type PinnedRequest,
  type PinnedResponse,
  requestPinned,
  resolveInWorkspace,
  runShellCommand,
  shellEnv,
} from "../src/stream/exec-native.js";
import { rotateConversationAfterRateLimit } from "../src/stream/session-state.js";
import type { StoredConversation } from "../src/stream/types.js";
import { createNativeShellFixture } from "./fixtures/native-shell-fixture.js";

describe("native shell environment", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "",
    Path: "/mixed",
    HOME: "/home/demo",
    LANG: "C",
    TMPDIR: "/tmp/demo",
    LC_ALL: "C",
    LC_PAPER: "C",
    LC_custom: "C",
    LC_: "bare",
    LC_0: "bad",
    LC_TIME_Z: "C",
    NOT_LC_TIME: "prefixed",
    "LC_TIME-EXTRA": "punctuation",
    "LC_TIME\n": "newline",
    LC_API_KEY: "vetoed",
    systemroot: "lower",
    SystemRoot: "exact",
    cOmspec: "mixed",
    comspec: "lower",
    PATHEXT: ".EXE",
    USERPROFILE: "/home/demo",
    TEMP: "/tmp/demo",
    TMP: "/tmp/demo",
    DEMO_COLOR: "blue",
    DEMO_EMPTY: "",
    DEMO_UNDEFINED: undefined,
    DEMO_UNUSED: "amber",
    PI_CURSOR_SHELL_ENV_EXTRA: "DEMO_UNUSED",
    AWS_ACCESS_KEY_ID: "vetoed",
    DATABASE_URL: "vetoed",
    demo_connection_string: "vetoed",
    CUSTOM_TOKEN: "vetoed",
    ["__proto__"]: "literal",
  };
  const flag =
    " \tDEMO_COLOR ,DEMO_EMPTY,DEMO_COLOR,DEMO_UNDEFINED,DEMO_UNKNOWN, __proto__," +
    " PI_CURSOR_SHELL_ENV_EXTRA,DEMO_*,DEMO_UNUSED=amber,1BAD,DEMO UNUSED,DEMO_UNUSED\n," +
    " CUSTOM_TOKEN,LC_API_KEY,AWS_ACCESS_KEY_ID,DATABASE_URL,demo_connection_string";
  const defaults = {
    PATH: "",
    HOME: "/home/demo",
    LANG: "C",
    TMPDIR: "/tmp/demo",
    LC_ALL: "C",
    LC_PAPER: "C",
    LC_TIME_Z: "C",
  };
  const windows = {
    ...defaults,
    LC_custom: "C",
    SystemRoot: "exact",
    cOmspec: "mixed",
    PATHEXT: ".EXE",
    USERPROFILE: "/home/demo",
    TEMP: "/tmp/demo",
    TMP: "/tmp/demo",
  };
  const optedIn = { DEMO_COLOR: "blue", DEMO_EMPTY: "", ["__proto__"]: "literal" };

  it.each([
    ["linux", undefined, defaults],
    ["darwin", flag, { ...defaults, ...optedIn }],
    ["linux", `${flag},Path`, { ...defaults, ...optedIn, Path: "/mixed" }],
    ["win32", "", windows],
    ["win32", flag.toLowerCase(), { ...windows, ...optedIn }],
  ] as const)(
    "selects the exact %s environment for the supplied grant",
    (platform, input, expected) => {
      const env = { ...parent };
      Object.setPrototypeOf(env, { DEMO_INHERITED: "inherited" });
      Object.defineProperty(env, "UNRELATED", {
        enumerable: true,
        get: () => {
          throw new Error("Excluded value was read");
        },
      });
      const before = Object.getOwnPropertyDescriptors(env);
      const extra = [...parseShellEnvExtra(input, platform), "DEMO_INHERITED"];
      const result = shellEnv(env, extra, platform);
      expect(Object.keys(result).sort()).toEqual(Object.keys(expected).sort());
      expect({ ...result }).toEqual(expected);
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.getOwnPropertyDescriptors(env)).toEqual(before);
    },
  );

  it.each([undefined, true, "", "  \t", ",*,ab.*,x=y,with\tspace,DEMO_UNUSED\r\n"] as const)(
    "treats a missing or invalid flag as zero extras",
    (value) => expect(parseShellEnvExtra(value, "linux")).toEqual([]),
  );

  it("deduplicates literal names using the platform's comparison", () => {
    const names = "Demo_Color,DEMO_COLOR, Demo_Color \t";
    expect(parseShellEnvExtra(names, "linux")).toEqual(["Demo_Color", "DEMO_COLOR"]);
    expect(parseShellEnvExtra(names, "win32")).toEqual(["Demo_Color"]);
    expect({ ...shellEnv({ Path: "/mixed" }, [], "win32") }).toEqual({ Path: "/mixed" });
    expect({
      ...shellEnv({ demo_color: "lower", dEmo_color: "ordinal" }, ["DEMO_COLOR"], "win32"),
    }).toEqual({ dEmo_color: "ordinal" });
    expect({
      ...shellEnv({ dEmo_color: "ordinal", demo_color: "lower" }, ["DEMO_COLOR"], "win32"),
    }).toEqual({ dEmo_color: "ordinal" });
  });

  it("checks the effective environment in both real native shell modes", () => {
    const { root, cwd, env } = createNativeShellFixture();
    try {
      const result = spawnSync(
        process.execPath,
        ["--no-env-file", path.join(import.meta.dir, "fixtures", "native-shell-dispatch.ts")],
        {
          cwd,
          env: { ...env, PI_CURSOR_SHELL_ENV_EXTRA: "DEMO_COLOR,DEMO_UNUSED" },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("NATIVE_SHELL_DISPATCH_PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("native exec workspace paths", () => {
  it("rejects paths that escape the workspace", () => {
    const resolved = resolveInWorkspace("../outside");
    expect("error" in resolved).toBe(true);
  });

  it("allows the workspace root and relative files", () => {
    expect("path" in resolveInWorkspace(".")).toBe(true);
    expect("path" in resolveInWorkspace("package.json")).toBe(true);
  });
});

describe("native exec handlers", () => {
  const prevCwd = process.cwd();
  let dir: string;
  let outside: string;

  afterEach(() => {
    process.chdir(prevCwd);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (outside) rmSync(outside, { recursive: true, force: true });
  });

  it("reads a workspace file on the exec channel", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    writeFileSync(path.join(dir, "note.md"), "hello from native read\nsecond line\n");
    process.chdir(dir);
    const dispatched = dispatchNativeExec("readArgs", { path: "note.md", offset: 1, limit: 1 });
    expect(dispatched?.kind).toBe("sync");
    if (dispatched?.kind !== "sync") return;
    const result = (
      dispatched.frame.value as { result: { case: string; value: { output?: { value?: string } } } }
    ).result;
    expect(result.case).toBe("success");
    expect(result.value.output?.value).toContain("hello from native read");
  });

  it("writes then lists a directory", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    process.chdir(dir);
    const write = dispatchNativeExec("writeArgs", {
      path: "src/a.ts",
      fileText: "export const a = 1;\n",
    });
    expect(write?.kind).toBe("sync");
    if (write?.kind !== "sync") return;
    expect((write.frame.value as { result: { case: string } }).result.case).toBe("success");
    const ls = dispatchNativeExec("lsArgs", { path: "src" });
    expect(ls?.kind).toBe("sync");
    if (ls?.kind !== "sync") return;
    expect((ls.frame.value as { result: { case: string } }).result.case).toBe("success");
  });

  it("denies write and delete through a workspace dir that symlinks outside", () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    outside = mkdtempSync(path.join(tmpdir(), "pi-cursor-outside-"));
    symlinkSync(outside, path.join(dir, "linkdir"));
    process.chdir(dir);
    const write = dispatchNativeExec("writeArgs", {
      path: "linkdir/pwned.txt",
      fileText: "escaped\n",
    });
    expect(write?.kind).toBe("sync");
    if (write?.kind !== "sync") return;
    expect((write.frame.value as { result: { case: string } }).result.case).toBe(
      "permissionDenied",
    );
    expect(existsSync(path.join(outside, "pwned.txt"))).toBe(false);
    const del = dispatchNativeExec("deleteArgs", { path: "linkdir/new.txt" });
    expect(del?.kind).toBe("sync");
    if (del?.kind !== "sync") return;
    expect((del.frame.value as { result: { case: string } }).result.case).toBe("permissionDenied");
  });

  it("greps workspace files and rejects an empty pattern", () => {
    expect(emptyGrepPatternRejection("", "*.ts")).toMatch(/empty/);
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src/a.ts"), "const needle = 1;\n");
    process.chdir(dir);
    const grep = dispatchNativeExec("grepArgs", { pattern: "needle", path: "." });
    expect(grep?.kind).toBe("sync");
    if (grep?.kind !== "sync") return;
    expect((grep.frame.value as { result: { case: string } }).result.case).toBe("success");
  });

  it("runs a shell command inside the workspace", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    process.chdir(dir);
    const dispatched = dispatchNativeExec("shellArgs", {
      command: "echo native-shell",
      workingDirectory: ".",
    });
    expect(dispatched?.kind).toBe("async");
    if (dispatched?.kind !== "async") return;
    const frame = await dispatched.run();
    expect(
      (frame.value as { result: { case: string; value: { stdout?: string } } }).result.case,
    ).toBe("success");
    expect(
      (frame.value as { result: { value: { stdout?: string } } }).result.value.stdout,
    ).toContain("native-shell");
  });

  it("returns output for the shell and read commands a firstmate turn runs", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    process.chdir(dir);
    writeFileSync(path.join(dir, "e2e.txt"), "pi+firstmate+cursor ok\n");

    // Cursor sends timeoutBehavior 2 (BACKGROUND) for these. The model only
    // continues if the stream ends with backgrounded, after the output.
    const commands = [
      { command: "echo shell-ok", stdout: "shell-ok", stderr: "" },
      { command: "printf '%s\\n' 'lock: held'", stdout: "lock: held", stderr: "" },
      {
        command: "printf '%s\\n' 'WAKE_ACK_REQUIRED' >&2",
        stdout: "",
        stderr: "WAKE_ACK_REQUIRED",
      },
    ];
    for (const item of commands) {
      const events = await shellStreamEvents(item.command, 2);
      expect(streamText(events, "stdout").trim()).toBe(item.stdout);
      expect(streamText(events, "stderr").trim()).toBe(item.stderr);
      expect(events.at(-1)?.case).toBe("backgrounded");
      expect(events.some((event) => event.case === "exit")).toBe(false);
    }

    const foreground = await shellStreamEvents("echo foreground");
    expect(streamText(foreground, "stdout")).toContain("foreground");
    expect(foreground.at(-1)?.case).toBe("exit");

    const read = dispatchNativeExec("readArgs", { path: "e2e.txt" });
    expect(read?.kind).toBe("sync");
    if (read?.kind !== "sync") return;
    const result = (
      read.frame.value as { result: { case: string; value: { output?: { value?: string } } } }
    ).result;
    expect(result.case).toBe("success");
    expect(result.value.output?.value).toContain("pi+firstmate+cursor ok");
  });

  it.skipIf(process.platform !== "linux")(
    "scrubs secrets from the parent's /proc environ before the shell runs",
    () => {
      const modulePath = path.resolve(import.meta.dir, "../src/stream/exec-native.ts");
      const script = `
        const { runShellCommand } = await import(${JSON.stringify(modulePath)});
        const r = await runShellCommand("tr '\\\\0' '\\\\n' < /proc/$PPID/environ | grep -c leak-me-not; true", process.cwd(), 5000);
        console.log(JSON.stringify({ seenByShell: r.stdout.trim(), ownEnv: process.env.CURSOR_ACCESS_TOKEN }));
      `;
      const out = spawnSync(process.execPath, ["--no-env-file", "-e", script], {
        env: { PATH: "/usr/bin:/bin", CURSOR_ACCESS_TOKEN: "leak-me-not" },
        encoding: "utf8",
      });
      expect(JSON.parse(out.stdout.trim())).toEqual({ seenByShell: "0", ownEnv: "leak-me-not" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "hard-kills the whole process group on timeout",
    async () => {
      dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
      const started = Date.now();
      const result = await runShellCommand("trap '' TERM; sleep 30 & wait", dir, 300);
      expect(result.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    },
  );
});

describe("native fetch refuses private and internal targets", () => {
  let calls: string[];

  function fakeRequest(respond: (url: string) => Partial<PinnedResponse>): PinnedRequest {
    calls = [];
    return (url, address) => {
      calls.push(`${url.href} @ ${address}`);
      return Promise.resolve({
        status: 200,
        headers: {},
        body: Buffer.from(""),
        ...respond(url.href),
      });
    };
  }

  it.each([
    "http://127.0.0.1:8080/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://172.16.5.5/",
    "http://192.168.1.1/",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://192.0.0.1/",
    "http://192.0.2.1/",
    "http://198.18.0.1/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[64:ff9b::a00:1]/",
    "http://[2001:db8::1]/",
    "http://[2002:a00:1::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",
    "http://localhost/",
  ])("denies %s without connecting", async (url) => {
    const request = fakeRequest(() => ({ body: Buffer.from("leak") }));
    await expect(fetchPublic(new URL(url), request)).rejects.toThrow("private or internal");
    expect(calls).toEqual([]);
  });

  it("denies on the exec channel too", async () => {
    const dispatched = dispatchNativeExec("fetchArgs", { url: "http://169.254.169.254/" });
    if (dispatched?.kind !== "async") throw new Error("fetchArgs should dispatch async");
    const frame = await dispatched.run();
    const result = (frame.value as { result: { case: string; value: { error?: string } } }).result;
    expect(result.case).toBe("error");
    expect(result.value.error).toContain("private or internal");
  });

  it("re-checks redirect hops instead of following them into the LAN", async () => {
    const request = fakeRequest(() => ({
      status: 302,
      headers: { location: "http://127.0.0.1/" },
    }));
    await expect(fetchPublic(new URL("http://93.184.216.34/"), request)).rejects.toThrow(
      "private or internal",
    );
    expect(calls).toEqual(["http://93.184.216.34/ @ 93.184.216.34"]);
  });

  it("refuses non-http redirect targets", async () => {
    const request = fakeRequest(() => ({
      status: 302,
      headers: { location: "file:///etc/passwd" },
    }));
    await expect(fetchPublic(new URL("http://93.184.216.34/"), request)).rejects.toThrow(
      "Only http and https",
    );
  });

  it("follows only real redirect statuses", async () => {
    const request = fakeRequest(() => ({
      status: 300,
      headers: { location: "http://127.0.0.1/" },
      body: Buffer.from("choices"),
    }));
    const response = await fetchPublic(new URL("http://93.184.216.34/"), request);
    expect(response.status).toBe(300);
    expect(response.body.toString()).toBe("choices");
    expect(calls).toHaveLength(1);
  });

  it("still fetches public hosts and follows public redirects to the checked address", async () => {
    const request = fakeRequest((url) =>
      url === "http://93.184.216.34/"
        ? {
            status: 301,
            headers: { location: "https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/x" },
          }
        : { body: Buffer.from("public body") },
    );
    const response = await fetchPublic(new URL("http://93.184.216.34/"), request);
    expect(response.body.toString()).toBe("public body");
    expect(calls).toEqual([
      "http://93.184.216.34/ @ 93.184.216.34",
      "https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/x @ 2606:2800:21f:cb07:6820:80da:af6b:8b2c",
    ]);
  });

  it("connects to the pinned address and keeps the URL host on the wire", async () => {
    const seen: { host?: string; url?: string } = {};
    const server = createServer((req, res) => {
      seen.host = req.headers.host;
      seen.url = req.url;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await requestPinned(
        new URL(`http://pinned.invalid:${port}/path?q=1`),
        "127.0.0.1",
        AbortSignal.timeout(5000),
      );
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/plain");
      expect(response.body.toString()).toBe("pinned body");
      expect(seen).toEqual({ host: `pinned.invalid:${port}`, url: "/path?q=1" });
    } finally {
      server.close();
    }
  });
});

interface ShellStreamEvent {
  case: string;
  data?: string;
}

async function shellStreamEvents(
  command: string,
  timeoutBehavior?: number,
): Promise<ShellStreamEvent[]> {
  const dispatched = dispatchNativeExec("shellStreamArgs", {
    command,
    workingDirectory: ".",
    ...(timeoutBehavior === undefined ? {} : { timeoutBehavior }),
  });
  if (dispatched?.kind !== "stream")
    throw new Error(`expected a shell stream, got ${dispatched?.kind}`);
  const events: ShellStreamEvent[] = [];
  await dispatched.run((frame) => {
    const event = (frame.value as { event: { case: string; value?: { data?: string } } }).event;
    events.push({ case: event.case, data: event.value?.data });
  });
  return events;
}

function streamText(events: ShellStreamEvent[], channel: "stdout" | "stderr"): string {
  return events
    .filter((event) => event.case === channel)
    .map((event) => event.data ?? "")
    .join("");
}

describe("conversation id rotation", () => {
  it("mints a new conversation id and drops the checkpoint", () => {
    const stored: StoredConversation = {
      conversationId: "old-id",
      checkpoint: new Uint8Array([1, 2, 3]),
      checkpointSource: "upstream",
      checkpointTurnCount: 1,
      checkpointHistoryFingerprint: "fp",
      sessionScoped: false,
      blobStore: new Map(),
      lastAccessMs: Date.now(),
    };
    rotateConversationAfterRateLimit(stored);
    expect(stored.conversationId).not.toBe("old-id");
    expect(stored.checkpoint).toBeNull();
  });
});
