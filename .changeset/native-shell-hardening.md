---
"@lykhoyda/pi-cursor-subscription": patch
---

Harden the opt-in native shell (`PI_CURSOR_NATIVE_EXEC=1`): strip secret-named env vars (`CURSOR_ACCESS_TOKEN` etc.) from the child, zero them in Pi's own exec-time environment block so `/proc/$PPID/environ` / `ps -E` cannot recover them, and SIGKILL the whole process group on timeout instead of SIGTERM-ing only `sh`.
