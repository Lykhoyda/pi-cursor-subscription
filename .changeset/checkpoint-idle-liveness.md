---
"@lykhoyda/pi-cursor-subscription": patch
---

The idle watchdog no longer treats Cursor checkpoint updates as model progress, so a silent turn times out within two idle windows.
