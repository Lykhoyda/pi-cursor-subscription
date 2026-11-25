---
"@lykhoyda/pi-cursor-subscription": patch
---

Limit the parent environment passed to Cursor-native shells to an allowlist. Tools that need an extra variable can pass its name through Pi's `--cursor-shell-env-extra` flag using the local `PI_CURSOR_SHELL_ENV_EXTRA` launcher variable documented in the README.
