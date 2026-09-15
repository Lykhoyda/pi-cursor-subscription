---
"@lykhoyda/pi-cursor-subscription": patch
---

Harden the opt-in native shell (`PI_CURSOR_NATIVE_EXEC=1`): strip secret-named env vars (`CURSOR_ACCESS_TOKEN` etc.) from the child and SIGKILL the whole process group on timeout instead of SIGTERM-ing only `sh`.
