---
"@lykhoyda/pi-cursor-subscription": patch
---

Native `fetch` (only reachable with `PI_CURSOR_NATIVE_EXEC=1`) now refuses IANA special-purpose addresses (loopback, RFC1918, CGNAT, link-local / cloud-metadata, TEST-NETs, benchmarking, 6to4 / NAT64 embeds, IPv6 ULA), connects to the address that passed the check instead of resolving DNS a second time, and re-checks every redirect hop (301/302/303/307/308) instead of following it blindly.
