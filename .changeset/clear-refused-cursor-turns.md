---
"@lykhoyda/pi-cursor-subscription": patch
---

Close the final Cursor bridge when a turn is refused after retries, so Pi can exit naturally. Preserve the latest checkpoint and published tool calls for recovery. Pi smokes now report a confirmed usage refusal after clean shutdown and fail when Pi or a bridge stays open.
