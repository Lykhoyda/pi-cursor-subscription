import { copyFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export function createNativeShellFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cursor-shell-env-")));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const temp = join(root, "tmp");
  for (const dir of [cwd, home, temp]) mkdirSync(dir);
  copyFileSync(join(import.meta.dir, "native-shell-child.ts"), join(cwd, "shell-probe.ts"));

  const win = process.platform === "win32";
  const env: NodeJS.ProcessEnv = {
    [win ? "Path" : "PATH"]: [
      dirname(process.execPath),
      ...(win ? ["C:\\Windows\\System32"] : []),
    ].join(delimiter),
    HOME: home,
    TMPDIR: temp,
    LANG: "C",
    LC_TIME: "C",
    DEMO_COLOR: "blue",
    DEMO_EMPTY: "",
    DEMO_UNUSED: "amber",
    DEMO_TOKEN: "dummy",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_CURSOR_SYSTEM_CREDENTIALS: "0",
    ...(win && {
      SystemRoot: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".EXE;.CMD",
      USERPROFILE: home,
      TEMP: temp,
      TMP: temp,
      USERDOMAIN: "DEMO_DOMAIN",
    }),
  };
  return { root, cwd, env };
}
