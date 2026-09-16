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
  type PinnedRequest,
  type PinnedResponse,
  requestPinned,
  resolveInWorkspace,
  runShellCommand,
  shellEnv,
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

  it("does not pass secret-looking env vars to the shell", async () => {
    expect(Object.keys(shellEnv({ CURSOR_ACCESS_TOKEN: "x", PATH: "/bin", HOME: "/h" }))).toEqual([
      "PATH",
      "HOME",
    ]);
    dir = mkdtempSync(path.join(tmpdir(), "pi-cursor-exec-"));
    const prevToken = process.env.CURSOR_ACCESS_TOKEN;
    process.env.CURSOR_ACCESS_TOKEN = "leak-me-not";
    try {
      const result = await runShellCommand('echo "[${CURSOR_ACCESS_TOKEN:-unset}]"', dir, 5_000);
      expect(result.stdout).toContain("[unset]");
      expect(result.stdout).not.toContain("leak-me-not");
    } finally {
      if (prevToken === undefined) delete process.env.CURSOR_ACCESS_TOKEN;
      else process.env.CURSOR_ACCESS_TOKEN = prevToken;
    }
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
      const out = spawnSync(process.execPath, ["-e", script], {
        env: { ...process.env, CURSOR_ACCESS_TOKEN: "leak-me-not" },
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
      return Promise.resolve({ status: 200, headers: {}, body: Buffer.from(""), ...respond(url.href) });
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
    const request = fakeRequest(() => ({ status: 302, headers: { location: "http://127.0.0.1/" } }));
    await expect(fetchPublic(new URL("http://93.184.216.34/"), request)).rejects.toThrow(
      "private or internal",
    );
    expect(calls).toEqual(["http://93.184.216.34/ @ 93.184.216.34"]);
  });

  it("refuses non-http redirect targets", async () => {
    const request = fakeRequest(() => ({ status: 302, headers: { location: "file:///etc/passwd" } }));
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
        ? { status: 301, headers: { location: "https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/x" } }
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
