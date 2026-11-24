import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeShellFixture } from "./fixtures/native-shell-fixture.js";

const ROOT = resolve(import.meta.dir, "..");
const projectHostEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const PINNED_HOSTS = join(import.meta.dir, "fixtures", "pi-hosts");
const pinnedHostVersions = ["0.86.1", "1.3.0"];

let pinnedHostsDir = "";
let probeBundle: ArrayBuffer;

function packageRoot(entry: string): string {
  return resolve(dirname(fileURLToPath(entry)), "..");
}

function packageVersion(root: string): string {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

beforeAll(async () => {
  const build = spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);

  pinnedHostsDir = mkdtempSync(join(tmpdir(), "pi-cursor-hosts-"));
  copyFileSync(join(PINNED_HOSTS, "package.json"), join(pinnedHostsDir, "package.json"));
  copyFileSync(join(PINNED_HOSTS, "bun.lock"), join(pinnedHostsDir, "bun.lock"));
  const install = spawnSync(
    process.execPath,
    ["install", "--frozen-lockfile", "--ignore-scripts", "--no-progress"],
    { cwd: pinnedHostsDir, encoding: "utf8" },
  );
  expect(install.status, install.stderr).toBe(0);

  const probe = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures", "native-shell-host.ts")],
    target: "node",
    format: "esm",
    external: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@bufbuild/protobuf"],
  });
  expect(probe.success).toBe(true);
  probeBundle = await probe.outputs[0]!.arrayBuffer();
}, 120_000);

afterAll(() => {
  if (pinnedHostsDir) rmSync(pinnedHostsDir, { recursive: true, force: true });
});

function linkExtensionDependency(fixture: string) {
  // Keep the published entry outside the checkout: Pi supplies its peer APIs
  // through the host loader, just as with an installed extension. Linking Pi
  // here would hide unsupported imports that the host does not virtualize.
  mkdirSync(join(fixture, "node_modules", "@bufbuild"), { recursive: true });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(
    join(ROOT, "node_modules", "@bufbuild", "protobuf"),
    join(fixture, "node_modules", "@bufbuild", "protobuf"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function loadBuiltExtension(hostRoot: string, version: string) {
  const { root: fixture, cwd, env } = createNativeShellFixture();
  try {
    mkdirSync(join(fixture, "dist"));
    copyFileSync(join(ROOT, "dist", "index.js"), join(fixture, "dist", "index.js"));
    linkExtensionDependency(fixture);
    const started = performance.now();
    const result = spawnSync(
      process.execPath,
      [
        join(hostRoot, "dist", "bundle", "cli.js"),
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-session",
        "--extension",
        join(fixture, "dist", "index.js"),
        "--print",
        "--provider",
        "cursor",
        "--model",
        "pi-startup-probe",
        "startup probe",
      ],
      {
        cwd,
        encoding: "utf8",
        timeout: 15_000,
        killSignal: "SIGKILL",
        env,
      },
    );
    const elapsed = Math.round(performance.now() - started);
    const phase = `Pi ${version} cold print after ${elapsed} ms`;
    const output = result.stdout + result.stderr;
    expect(result.error, phase).toBeUndefined();
    expect(result.signal, phase).toBeNull();
    expect(output).not.toContain("Failed to load extension");
    expect(output).not.toContain("Unknown provider");
    // Reaching credential validation proves the extension registered Cursor.
    // No credentials or network request are needed to verify startup.
    expect(output).toContain("No API key found for cursor");
    expect(result.status, phase).toBe(1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const INITIAL_PROOF = "before\nstarted\n";
// Leave time to reap the host after its separate eight-second proof window.
const STANDALONE_PROBE_TIMEOUT_MS = 18_000;

interface HostProbe {
  waitFor(phase: string, expected: string): Promise<void>;
  reload(): Promise<void>;
  assertRunning(): void;
  finish(): Promise<void>;
}

async function withHostProbe(
  hostRoot: string,
  version: string,
  scenario: "dotenv" | "export" | "grant" | "wrong",
  run: (probe: HostProbe) => Promise<void>,
) {
  const { root, cwd, env } = createNativeShellFixture();
  try {
    linkExtensionDependency(root);
    const extension = join(root, "shell-host.js");
    writeFileSync(extension, new Uint8Array(probeBundle));
    env.CURSOR_ACCESS_TOKEN = "fixture-token";
    const flagged = scenario === "grant" || scenario === "wrong";
    if (!flagged) env.HOST_PROBE_AMBIENT = "1";
    if (scenario === "dotenv") {
      writeFileSync(join(cwd, ".env"), "PI_CURSOR_SHELL_ENV_EXTRA=DEMO_COLOR\n");
    }
    if (scenario === "export") env.PI_CURSOR_SHELL_ENV_EXTRA = "DEMO_COLOR";

    let command = [
      process.execPath,
      join(hostRoot, "dist", "bundle", "cli.js"),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-session",
      "--extension",
      extension,
      "--mode",
      "rpc",
    ];
    if (flagged) {
      env.HOST_PROBE_GRANT = "1";
      const name = scenario === "wrong" ? "DEMO_UNUSED" : "DEMO_COLOR";
      if (process.platform === "win32") {
        const piArgs = command.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ");
        command = [
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$PI_CURSOR_SHELL_ENV_EXTRA = '${name}'; ` +
            `& ${piArgs} --cursor-shell-env-extra "$PI_CURSOR_SHELL_ENV_EXTRA"; exit $LASTEXITCODE`,
        ];
      } else {
        command = [
          "/bin/sh",
          "-c",
          `PI_CURSOR_SHELL_ENV_EXTRA=${name}\n` +
            'exec "$@" --cursor-shell-env-extra "$PI_CURSOR_SHELL_ENV_EXTRA"',
          "launch",
          ...command,
        ];
      }
    }
    const started = performance.now();
    const child = Bun.spawn(command, {
      cwd,
      env,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    const proof = join(cwd, "host-shell-proof.txt");
    let watchdogFired = false;
    const watchdog = setTimeout(
      () => {
        watchdogFired = true;
        child.kill("SIGKILL");
      },
      scenario === "grant" ? 26_000 : STANDALONE_PROBE_TIMEOUT_MS,
    );
    const failure = (phase: string, reason: string) =>
      new Error(
        `Pi ${version} ${scenario} ${phase} after ${Math.round(performance.now() - started)} ms: ${reason}`,
      );
    try {
      await run({
        async waitFor(phase, expected) {
          const deadline = performance.now() + 8_000;
          while (performance.now() < deadline) {
            if (watchdogFired) throw failure(phase, "child watchdog fired");
            const markers = existsSync(proof) ? readFileSync(proof, "utf8") : "";
            if (markers === expected) return;
            if (markers.endsWith("failed\n")) throw failure(phase, "shell marker failed");
            if (child.exitCode !== null || child.signalCode !== null) {
              throw failure(phase, "child exited before the expected marker");
            }
            await Bun.sleep(25);
          }
          throw failure(phase, "proof deadline elapsed");
        },
        async reload() {
          await child.stdin.write('{"type":"prompt","message":"/reload-shell-probe"}\n');
          await child.stdin.flush();
        },
        assertRunning() {
          if (watchdogFired || child.exitCode !== null || child.signalCode !== null) {
            throw failure("peer overlap", "flagged host stopped before its peer");
          }
        },
        async finish() {
          await child.stdin.end();
          const code = await child.exited;
          if (watchdogFired || code !== 0 || child.signalCode !== null) {
            throw failure(
              "EOF exit",
              `status=${code} signal=${child.signalCode} watchdog=${watchdogFired}`,
            );
          }
        },
      });
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("built dist without extension-local Pi dependencies", () => {
  const projectVersion = packageVersion(packageRoot(projectHostEntry));
  for (const version of [projectVersion, ...pinnedHostVersions]) {
    describe(`Pi ${version}`, () => {
      const projectHost = version === projectVersion;
      const hostEntry = () =>
        projectHost
          ? projectHostEntry
          : import.meta.resolve(`pi-${version}`, join(pinnedHostsDir, "package.json"));
      const hostRoot = () => packageRoot(hostEntry());

      it("loads the published bundle from a cold print startup", () => {
        const entry = hostEntry();
        const aiEntry = import.meta.resolve("@earendil-works/pi-ai", entry);
        if (projectHost) {
          const coreEntry = import.meta.resolve("@earendil-works/pi-agent-core", entry);
          expect(aiEntry).toBe(import.meta.resolve("@earendil-works/pi-ai"));
          expect(import.meta.resolve("@earendil-works/pi-ai", coreEntry)).toBe(aiEntry);
        } else {
          expect(packageVersion(hostRoot())).toBe(version);
          expect(packageVersion(packageRoot(aiEntry))).toBe(version);
        }
        loadBuiltExtension(hostRoot(), version);
      }, 18_000);

      let pair: Promise<void> | undefined;
      const verifyPair = () =>
        (pair ??= withHostProbe(hostRoot(), version, "grant", async (grant) => {
          await grant.waitFor("startup", INITIAL_PROOF);
          await withHostProbe(hostRoot(), version, "dotenv", async (peer) => {
            await peer.waitFor("startup", INITIAL_PROOF);
            await peer.finish();
          });
          grant.assertRunning();
          await grant.reload();
          await grant.waitFor("reload", INITIAL_PROOF.repeat(2));
          await grant.finish();
        }));

      it(
        "keeps the CLI grant through reload and denies a concurrent dotenv grant",
        verifyPair,
        30_000,
      );

      describe("after the flagged host exits", () => {
        beforeAll(verifyPair, 30_000);
        it(
          "denies the ambient list in a fresh export-only host",
          () =>
            withHostProbe(hostRoot(), version, "export", async (fresh) => {
              await fresh.waitFor("startup", INITIAL_PROOF);
              await fresh.finish();
            }),
          STANDALONE_PROBE_TIMEOUT_MS + 4_000,
        );
      });

      if (projectHost) {
        it(
          "reports and reaps a launcher with the wrong grant",
          async () => {
            await withHostProbe(hostRoot(), version, "wrong", async (probe) => {
              await probe.waitFor("failure control", "before\nfailed\n");
            });
          },
          STANDALONE_PROBE_TIMEOUT_MS + 4_000,
        );
      }
    });
  }
});
