import { realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const env = process.env;
const win = process.platform === "win32";
const fixture = dirname(realpathSync(process.cwd()));
const mode = process.argv[2];
const expectedPath = [dirname(process.execPath), ...(win ? ["C:\\Windows\\System32"] : [])].join(
  delimiter,
);
const passed =
  realpathSync(process.cwd()) === join(fixture, "workspace") &&
  env.HOME === join(fixture, "home") &&
  env.TMPDIR === join(fixture, "tmp") &&
  (env.PATH ?? env.Path) === expectedPath &&
  env.LANG === "C" &&
  env.LC_TIME === "C" &&
  env.DEMO_COLOR === (mode === "deny" ? undefined : "blue") &&
  env.DEMO_EMPTY === (mode === "extended" ? "" : undefined) &&
  env.DEMO_MISSING === undefined &&
  env.DEMO_UNUSED === undefined &&
  env.DEMO_TOKEN === undefined &&
  env.PI_CURSOR_SHELL_ENV_EXTRA === undefined &&
  (!win ||
    ((env.SystemRoot ?? env.SYSTEMROOT) === "C:\\Windows" &&
      env.USERPROFILE === join(fixture, "home") &&
      env.TEMP === join(fixture, "tmp") &&
      env.USERDOMAIN === "DEMO_DOMAIN"));

console.log(passed ? "SHELL_ENV_PASS" : "SHELL_ENV_FAIL");
process.exitCode = passed ? 0 : 1;
