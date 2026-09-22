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

By default this fork **does not** run Cursor-native `shell`, `fetch`, `write`, or `delete` on the open Run RPC. Those execs are rejected so Pi MCP tools (and Pi's confirmation UI) handle them — `bash` for shell, `edit` or `write` for file changes. That default is only viable when the session actually advertises those tools. Read/ls/grep still run natively.

To restore upstream 1.4.31+ behaviour:

```bash
export PI_CURSOR_NATIVE_EXEC=1
```

Even with the flag on, native `fetch` only allows `http`/`https` to public addresses: IANA special-purpose ranges (loopback, RFC1918, CGNAT, link-local / cloud metadata, TEST-NETs, benchmarking, 6to4 / NAT64 embeds, IPv6 ULA) are refused. The socket connects to the address that passed the check (SNI and Host keep the URL's name), and every redirect hop is re-checked.

With the flag on, native `shell` is **not sandboxed**: only the starting cwd is workspace-checked; the command can `cd` anywhere your user can. The child environment is `process.env` minus any variable whose name contains `TOKEN`, `SECRET`, `PASSWORD`/`PASSWD`, `API_KEY`, `PRIVATE_KEY`, or `CREDENTIAL` (so `CURSOR_ACCESS_TOKEN` never reaches a model-controlled shell), and the 30s timeout SIGKILLs the process group. Because a same-user child can also read the Pi process's own exec-time environment (`/proc/$PPID/environ` on Linux, `ps -E` on macOS), those entries are zeroed in Pi's memory before the first native shell runs; Windows is not scrubbed. The shell can still read anything else your user can (`~/.pi/agent/auth.json` included), so run Pi inside a container or VM if you opt in.

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
