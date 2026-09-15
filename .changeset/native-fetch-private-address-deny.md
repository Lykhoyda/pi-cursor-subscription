---
"@lykhoyda/pi-cursor-subscription": patch
---

Native `fetch` (only reachable with `PI_CURSOR_NATIVE_EXEC=1`) now refuses loopback, RFC1918, CGNAT, link-local / cloud-metadata, IPv6 ULA, and other internal addresses, and re-checks every redirect hop instead of following it blindly.
