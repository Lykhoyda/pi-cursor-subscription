import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  dispatchNativeExec,
  emptyGrepPatternRejection,
  resolveInWorkspace,
} from "../src/stream/exec-native.js";
import { rotateConversationAfterRateLimit } from "../src/stream/session-state.js";
import type { StoredConversation } from "../src/stream/types.js";

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
});

describe("native fetch refuses private and internal targets", () => {
  const realFetch = globalThis.fetch;
  let calls: string[];

  function stubFetch(respond: (url: string) => Response): void {
    calls = [];
    globalThis.fetch = ((input: URL | Request | string) => {
      calls.push(String(input));
      return Promise.resolve(respond(String(input)));
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function runFetch(url: string) {
    const dispatched = dispatchNativeExec("fetchArgs", { url });
    if (dispatched?.kind !== "async") throw new Error("fetchArgs should dispatch async");
    const frame = await dispatched.run();
    return (frame.value as { result: { case: string; value: { error?: string; content?: string } } })
      .result;
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
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",
    "http://localhost/",
  ])("denies %s without calling fetch", async (url) => {
    stubFetch(() => new Response("leak"));
    const result = await runFetch(url);
    expect(result.case).toBe("error");
    expect(result.value.error).toContain("private or internal");
    expect(calls).toEqual([]);
  });

  it("re-checks redirect hops instead of following them into the LAN", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }));
    const result = await runFetch("http://93.184.216.34/");
    expect(result.case).toBe("error");
    expect(result.value.error).toContain("private or internal");
    expect(calls).toEqual(["http://93.184.216.34/"]);
  });

  it("refuses non-http redirect targets", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }));
    const result = await runFetch("http://93.184.216.34/");
    expect(result.case).toBe("error");
    expect(result.value.error).toContain("Only http and https");
  });

  it("still fetches public hosts and follows public redirects", async () => {
    stubFetch((url) =>
      url === "http://93.184.216.34/"
        ? new Response(null, { status: 301, headers: { location: "https://93.184.216.34/x" } })
        : new Response("public body"),
    );
    const result = await runFetch("http://93.184.216.34/");
    expect(result.case).toBe("success");
    expect(result.value.content).toBe("public body");
    expect(calls).toEqual(["http://93.184.216.34/", "https://93.184.216.34/x"]);
  });
});

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
