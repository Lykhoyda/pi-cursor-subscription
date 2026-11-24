# Security Policy

## Supported versions

Security fixes are applied to the latest published `1.x` release. Please upgrade to the latest version before reporting an issue.

## Reporting a vulnerability

Please prefer [GitHub private vulnerability reporting](https://github.com/Lykhoyda/pi-cursor-subscription/security/advisories/new) when it is enabled. Otherwise open a [GitHub issue](https://github.com/Lykhoyda/pi-cursor-subscription/issues). Include:

- a clear description and impact assessment;
- reproducible steps or a minimal proof of concept;
- affected versions and environment details; and
- a suggested remediation, if available.

We will acknowledge valid reports, investigate them privately, and coordinate a fix and disclosure. Do not include OAuth access tokens, refresh tokens, client secrets, or other credentials in your report.

## Scope

This repository contains a Pi extension that handles OAuth credentials and sends requests to Cursor Connect endpoints. Reports involving credential exposure, unsafe endpoint handling, OAuth callback validation, request construction, dependency vulnerabilities, or release automation are in scope.

## Access tokens & secrets

Treat access and refresh tokens in `~/.pi/agent/auth.json`, Keychain, or `state.vscdb` as sensitive. Do not share or commit session tokens.

### Privileged native exec

By default this fork **runs** Cursor-native `shell`, `fetch`, `write`, and `delete` on the open Run RPC, matching upstream 1.4.31+. Read/ls/grep also run natively. A session with no Pi MCP tools (`bash`, `edit`, `write`) can still act.

To reject those execs and force them through Pi MCP tools (and Pi's confirmation UI):

```bash
export PI_CURSOR_NATIVE_EXEC=0
```

Native `fetch` only allows `http`/`https` to public addresses: IANA special-purpose ranges (loopback, RFC1918, CGNAT, link-local / cloud metadata, TEST-NETs, benchmarking, 6to4 / NAT64 embeds, IPv6 ULA) are refused. The socket connects to the address that passed the check (SNI and Host keep the URL's name), and every redirect hop is re-checked.

Native `shell` runs with your user's permissions. The workspace check applies to the starting cwd. The 30-second timeout terminates the process group on POSIX and the direct child on Windows.

The extension builds the spawn environment from an empty map. It copies `PATH`, `HOME`, `LANG`, `TMPDIR`, and names matching `^LC_[A-Z][A-Z0-9_]*$`. Native Windows also allows `SystemRoot`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `TEMP`, and `TMP` and matches names case-insensitively. The allowlist applies to the map the extension supplies to Bun. On Windows, Bun's libuv launcher can fill missing `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, and `WINDIR` from the parent. Shells and tools can also initialize their own variables.

A trusted local launcher can expand `PI_CURSOR_SHELL_ENV_EXTRA` into one quoted argument to `pi --cursor-shell-env-extra` before startup. Only Pi's parsed string flag can grant extra names. An export, workspace dotenv file, or server request alone grants zero extras. The extension reads allowed values from Pi's environment, including values Bun loaded from dotenv. The grant controls names only. The spawn map excludes `PI_CURSOR_SHELL_ENV_EXTRA` itself and always rejects names containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY` (or `APIKEY`), `PRIVATE_KEY`, `CREDENTIAL`, `ACCESS_KEY`, `DATABASE_URL`, or `CONNECTION_STRING`, even for a locale name or a named grant.

Same-user commands can access data outside the spawn environment, including files such as `~/.pi/agent/auth.json`. Before the first native shell, the extension makes a best-effort attempt to zero secret-named entries in Pi's original environment block on Linux and macOS. That scrub covers the secret-name patterns above and is unavailable on Windows. Other excluded entries may still be accessible through the parent. Use a container or VM for isolation, or set `PI_CURSOR_NATIVE_EXEC=0` to disable privileged native exec.

### Hosted web / Exa fetch

By default this fork **rejects** Cursor-hosted web search, Exa search, Exa fetch, and unnamed web-fetch permission prompts. Those turns should use Pi MCP tools (with Pi's confirmation UI) instead. This is independent of `PI_CURSOR_NATIVE_EXEC`.

To restore auto-approval of hosted web/Exa:

```bash
export PI_CURSOR_HOSTED_WEB=1
```

### System credential reuse

By default, `pi-cursor` may read Cursor CLI Keychain items and Cursor IDE `state.vscdb` to reuse an existing login. Disable that behavior with:

```bash
export PI_CURSOR_SYSTEM_CREDENTIALS=0
```

When disabled, authenticate only via `/login cursor` or `CURSOR_ACCESS_TOKEN`.

On WSL, only the current Windows user's `state.vscdb` is read (`USERPROFILE` / `USERNAME`). Other profiles under `/mnt/c/Users` are not scanned.

### Agent URL allowlist

Custom agent URLs (`PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL`) must use an allowed Cursor host (`*.cursor.sh` / `*.cursor.com` or localhost). This reduces token exfiltration risk from a poisoned base URL.
