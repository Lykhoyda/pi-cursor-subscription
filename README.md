# @lykhoyda/pi-cursor-subscription

Use the models on your [Cursor](https://cursor.com) subscription inside the [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). After you sign in, Pi can call Claude, GPT, Composer, Gemini, Grok, Kimi, and whatever else your Cursor account currently offers. No separate provider API key.

This package registers a `cursor` provider. It is a fork of [`@rahularya01/pi-cursor`](https://github.com/Rahularya01/pi-cursor).

> **Unofficial.** Not affiliated with Cursor / Anysphere. The protocol is reverse-engineered and can change. Use only on accounts you are allowed to access, and read the source before `/login cursor`.

## Requirements

- [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) and Pi AI `>= 0.86.1` (including Pi 1.3.0)
- [Bun](https://bun.com) `>= 1.4.0` (the only supported runtime)
- A Cursor account

## Install

Installs the release currently published on npm. How a release is published is in [CONTRIBUTING.md](CONTRIBUTING.md#releases).

```bash
pi install npm:@lykhoyda/pi-cursor-subscription
```

Restart Pi or run `/reload`. To update this package later:

```bash
pi update npm:@lykhoyda/pi-cursor-subscription
```

## Quick start

1. **Sign in.** If the Cursor desktop app is logged in on this machine (or the Cursor CLI on macOS), that login is reused. Otherwise:

   ```text
   /login cursor
   ```

2. **Pick a model.** Open `/model` and choose a `cursor/…` row, or list ids, context windows, and thinking levels:

   ```text
   /cursor.models
   ```

   The live catalog comes from Cursor after you sign in. It can differ by plan.

3. **Chat.** If something fails, run `/cursor.doctor` first (token source, endpoint, last error).

## Usage and config

### Commands

| Command | What it does |
| --- | --- |
| `/login cursor` | Browser sign-in; refreshes the model list |
| `/model cursor/<id>` | Select a Cursor model |
| `/cursor.models` | List models, context windows, and thinking levels |
| `/cursor.models all` | Include internal tab/chat variants |
| `/cursor.usage` | Print plan quota and on-demand spend |
| `/cursor.doctor` | Sanitized diagnostics |

Pi thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) map onto Cursor variants when the model advertises them. Limit the picker with `enabledModels` in `~/.pi/agent/settings.json`.

### Authentication

Credentials are tried in this order:

1. `CURSOR_ACCESS_TOKEN`
2. Pi OAuth store (`~/.pi/agent/auth.json` from `/login cursor`)
3. Cursor CLI tokens in the macOS Keychain (`cursor-access-token` / `cursor-refresh-token`)
4. Cursor IDE `globalStorage/state.vscdb` (macOS, Linux, Windows, or WSL; on WSL, the current Windows user only)

`/login cursor` wins over harvested CLI/IDE tokens so another Cursor login on the machine does not silently override yours.

To skip Keychain / IDE reuse:

```bash
export PI_CURSOR_SYSTEM_CREDENTIALS=0
```

### Native exec and hosted web

By default, Cursor-native **shell**, **fetch**, **write**, and **delete** run on the open Run RPC, outside Pi's sandbox and confirmation UI, so a session with no Pi tools can still act. **read**, **ls**, and **grep** always run on that channel.

Native **shell** is not sandboxed: only the starting directory is checked; the command can `cd` anywhere your user can. Secret-named env vars are stripped from the child and zeroed in Pi's own inspectable environment. See [SECURITY.md](SECURITY.md#privileged-native-exec). Run Pi in a container or VM if that risk is unacceptable, or turn native exec off:

```bash
export PI_CURSOR_NATIVE_EXEC=0
```

With that set, privileged execs go through Pi tools (`bash`, `edit`, `write`) instead.

Native **fetch** refuses loopback, private-network, link-local / cloud-metadata, and other internal addresses, including via redirects.

Cursor-hosted web search / Exa fetch prompts are **rejected** unless you opt in (`PI_CURSOR_HOSTED_WEB=1`). That flag is independent of native exec.

Cursor can see Pi's MCP tools. Cursor subagents are not supported and return an error.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSOR_ACCESS_TOKEN` | unset | Access token override |
| `PI_CURSOR_SYSTEM_CREDENTIALS` | on | Set `0` to disable Keychain / IDE harvest |
| `PI_CURSOR_NATIVE_EXEC` | on | Set `0` to reject privileged native exec |
| `PI_CURSOR_HOSTED_WEB` | off | Set `1` to auto-approve hosted web / Exa |
| `PI_CURSOR_CLIENT_VERSION` | bundled default | Pin the `x-cursor-client-version` header |
| `PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL` | Cursor's agent host | Must be `*.cursor.sh` / `*.cursor.com` or localhost |
| `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS` | `180000` (3 min) | Silence watchdog; `0` disables |
| `PI_CURSOR_CACHE_DIR` | `~/.cache/pi-cursor` | Model catalog cache (`$XDG_CACHE_HOME/pi-cursor` if set) |
| `PI_CURSOR_PROVIDER_DEBUG` | off | Verbose debug log |
| `PI_PROXY_CURSOR` / `PI_PROXY` / `HTTPS_PROXY` | unset | HTTP CONNECT proxy |

## Troubleshooting

- **`No API provider registered for api: cursor-native`:** `pi update npm:@lykhoyda/pi-cursor-subscription` then `/reload`.
- **401 / not logged in:** `/login cursor`, or check `/cursor.doctor` (`tokenSource`).
- **Hung stream / wire errors:** `/cursor.doctor` (`clientVersion`, `wireDrift`). Try pinning `PI_CURSOR_CLIENT_VERSION`, or set `PI_CURSOR_PROVIDER_DEBUG=1`.
- **Stale model list:** Open `/model` to refresh, or delete the cache under `PI_CURSOR_CACHE_DIR`.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Attributions

Wire patterns from [opencode-cursor](https://github.com/ephraimduncan/opencode-cursor) and [@pi-stef/cursor](https://www.npmjs.com/package/@pi-stef/cursor). Upstream: [Rahularya01/pi-cursor](https://github.com/Rahularya01/pi-cursor).

## License

[MIT](LICENSE)
