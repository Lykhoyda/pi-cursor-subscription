import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dir, "..");
const hostEntry = import.meta.resolve("pi130-coding-agent");
const hostRoot = resolve(dirname(fileURLToPath(hostEntry)), "..");

it("loads built dist in official Pi 1.3.0 without extension-local Pi dependencies", () => {
  const hostPackage = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
  expect(hostPackage.version).toBe("1.3.0");
  const aiEntry = import.meta.resolve("@earendil-works/pi-ai", hostEntry);
  const aiRoot = resolve(dirname(fileURLToPath(aiEntry)), "..");
  expect(JSON.parse(readFileSync(join(aiRoot, "package.json"), "utf8")).version).toBe("1.3.0");

  const build = spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);

  // Keep the published entry outside the checkout: Pi supplies its peer APIs
  // through the host loader, just as with an installed extension. Linking Pi
  // here would hide unsupported imports that the host does not virtualize.
  const fixture = mkdtempSync(join(tmpdir(), "pi-cursor-pi130-"));
  try {
    mkdirSync(join(fixture, "dist"));
    mkdirSync(join(fixture, "node_modules", "@bufbuild"), { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    copyFileSync(join(ROOT, "dist", "index.js"), join(fixture, "dist", "index.js"));
    symlinkSync(join(ROOT, "node_modules", "@bufbuild", "protobuf"), join(fixture, "node_modules", "@bufbuild", "protobuf"));
    const result = spawnSync(process.execPath, [
      join(hostRoot, "dist", "bundle", "cli.js"),
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-session",
      "--extension", join(fixture, "dist", "index.js"),
      "--print", "--provider", "cursor", "--model", "pi130-startup-probe",
      "startup probe",
    ], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        HOME: fixture,
        PI_CODING_AGENT_DIR: join(fixture, "agent"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_CURSOR_SYSTEM_CREDENTIALS: "0",
      },
    });
    const output = result.stdout + result.stderr;
    expect(result.error).toBeUndefined();
    expect(output).not.toContain("Failed to load extension");
    expect(output).not.toContain("Unknown provider");
    // Reaching credential validation proves the extension registered Cursor.
    // No credentials or network request are needed to verify startup.
    expect(output).toContain("No API key found for cursor");
    expect(result.status).toBe(1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
