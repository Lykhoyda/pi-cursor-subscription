---
"@lykhoyda/pi-cursor-subscription": patch
---

Register Cursor Grok 4.7 with its 256K default window, 500K Max Mode window, and `reasoning_effort` levels. GetUsableModels rows were stuck at 200K, and the effort parameter was dropped because Cursor names it `reasoning_effort` rather than `effort`.
