---
"@lykhoyda/pi-cursor-subscription": patch
---

Fix extension startup on Pi 1.3.0 by importing transcript helpers through the host-provided pi-ai root API. Require Pi Coding Agent and Pi AI 0.86.1 or newer, and test the built extension with Pi 1.3.0 without extension-local Pi dependencies.
