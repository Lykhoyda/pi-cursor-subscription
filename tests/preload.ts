import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_CURSOR_LIFECYCLE_LOG?.trim()) {
  process.env.PI_CURSOR_LIFECYCLE_LOG = join(tmpdir(), `pi-cursor-test-lifecycle-${process.pid}.jsonl`);
}
