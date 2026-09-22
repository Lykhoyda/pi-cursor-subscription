---
"@lykhoyda/pi-cursor-subscription": patch
---

Cancel an in-flight native shell when Cursor aborts, and stop pausing the stream idle watchdog during native exec so a stuck shell cannot leave the bridge open forever. Shell streams Cursor marks as background end with a backgrounded event after their output, so the turn resumes. `/cursor.doctor` prints the resolved idle-watchdog values.
