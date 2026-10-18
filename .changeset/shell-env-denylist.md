---
"@lykhoyda/pi-cursor-subscription": patch
---

Widen the native-shell env denylist so `AWS_ACCESS_KEY_ID`, `DATABASE_URL`, and `CONNECTION_STRING` are stripped from the child and from the parent environ scrub, matching names that `TOKEN`/`SECRET` already covered.
