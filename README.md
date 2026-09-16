# @lykhoyda/pi-cursor-subscription

Use your **Cursor** subscription models (Composer, Claude, GPT, Grok, and others) inside the [**Pi Coding Agent**](https://github.com/earendil-works/pi-coding-agent). This package registers a `cursor` provider that talks to Cursor's agent backend over HTTP/2 (Connect + Protobuf). No separate API key and no Cursor CLI subprocess per turn.

Fork of [`@rahularya01/pi-cursor`](https://github.com/Rahularya01/pi-cursor) **1.5.0** (based on upstream 1.4.34). Version bumps go through [Changesets](https://changesets.dev/); a matching `v*` tag publishes `@lykhoyda/pi-cursor-subscription` to npm.

> **Unofficial.** Not affiliated with Cursor / Anysphere. Community reverse-engineered wire details; Cursor can change protocols anytime. Use only on accounts you are allowed to access, and review the source before `/login cursor`.

## Requirements

|                             |                                                  |
| --------------------------- | ------------------------------------------------ |
| **Pi Coding Agent / Pi AI** | `>= 0.80.0`                                      |
| **Bun**                     | `>= 1.4.0` (only supported runtime)              |
| **Cursor account**          | Signed in via app, CLI, or `/login cursor` below |

## Install

```bash
pi install git:github.com/Lykhoyda/pi-cursor-subscription
```

Restart Pi or run `/reload`. To update:

```bash
pi update git:github.com/Lykhoyda/pi-cursor-subscription
```

## Quick start

1. **Sign in** — if the Cursor app or CLI (`cursor` / `agent`) is already logged in on this machine, credentials are picked up automatically. Otherwise:

   ```text
   /login cursor
   ```

2. **Choose a model** (examples; your account may differ):

   ```text
   /model cursor/composer-2.5
   ```

   Run `/cursor.models` for the live catalog.

3. **Chat.** If something fails, run `/cursor.doctor` first (token source, endpoint, last error).

## Privileged native exec (default: off)

On the open Run RPC, this fork **rejects** Cursor-native **`shell`**, **`fetch`**, **`write`**, and **`delete`** execs unless you opt in. The model should use **Pi MCP tools** instead (with Pi's confirmation UI). **Read**, **ls**, and **grep** still run on the native exec channel.

Restore upstream 1.4.31+ behaviour only if you accept that risk:

```bash
export PI_CURSOR_NATIVE_EXEC=1
```

With the flag on, native `fetch` still refuses loopback, private-network, link-local / cloud-metadata, and other internal addresses, including via redirects.

With the flag on, native `shell` runs **unconfined** as your user (only its starting directory is workspace-checked); secret-named env vars are stripped from the child and zeroed in Pi's own inspectable environment. See [SECURITY.md](SECURITY.md#privileged-native-exec) and run Pi in a container or VM if you enable this.

Cursor-hosted web search / Exa fetch permission prompts are also **rejected** unless you opt in (`PI_CURSOR_HOSTED_WEB=1`). That flag is independent of native exec.

See [SECURITY.md](SECURITY.md) for credential handling and URL allowlisting.

## Authentication

Credentials resolve in order:

1. `CURSOR_ACCESS_TOKEN`
2. Pi OAuth store (`~/.pi/agent/auth.json` from `/login cursor`)
3. Cursor CLI Keychain (`cursor-access-token` / `cursor-refresh-token`)
4. Cursor IDE `globalStorage/state.vscdb` (macOS, Linux, Windows, or WSL — current Windows user only on WSL)

`/login cursor` wins over harvested CLI/IDE tokens so another Cursor login on the machine does not silently override yours.

Opt out of Keychain / IDE / WSL harvest:

```bash
export PI_CURSOR_SYSTEM_CREDENTIALS=0
```

## Commands

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `/login cursor`      | Browser PKCE sign-in; refreshes the model catalog |
| `/model cursor/<id>` | Select a Cursor model                             |
| `/cursor.models`     | List models, context windows, thinking levels     |
| `/cursor.models all` | Include internal tab/chat variants                |
| `/cursor.usage`      | Usage quota TUI                                   |
| `/cursor.doctor`     | Sanitized diagnostics                             |

Reasoning effort (`off` … `max`) maps to Cursor's model variants. Restrict the picker in `~/.pi/agent/settings.json` with `enabledModels`.

## Troubleshooting

- **`No API provider registered for api: cursor-native`:** `pi update git:github.com/Lykhoyda/pi-cursor-subscription` and `/reload`.
- **401 / not logged in:** `/login cursor` or check `/cursor.doctor` (`tokenSource`).
- **Hung stream / wire errors:** `/cursor.doctor` (`clientVersion`, `wireDrift`); see [AGENTS.md](AGENTS.md) for env tuning (`PI_CURSOR_CLIENT_VERSION`, timeouts, debug flags).
- **Stale model list:** Open `/model` to refresh, or clear `PI_CURSOR_CACHE_DIR` (default under `~/.cache/pi-cursor`).

## Development

```bash
bun install
bun run check
bun run smoke:pi-grok   # live: pi + this provider + Grok 4.6 (needs a Cursor login)
```

Architecture, module layout, and the full environment variable list live in [AGENTS.md](AGENTS.md).

## Attributions

Wire patterns from [opencode-cursor](https://github.com/ephraimduncan/opencode-cursor) and [@pi-stef/cursor](https://www.npmjs.com/package/@pi-stef/cursor). Upstream: [Rahularya01/pi-cursor](https://github.com/Rahularya01/pi-cursor).

## License

[MIT](LICENSE)
