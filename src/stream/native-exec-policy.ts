/**
 * Privileged Cursor-native exec (shell, fetch, write, delete) is opt-in.
 *
 * Upstream 1.4.31 runs those handlers on the open Run RPC with no Pi MCP
 * confirmation. This fork keeps read/ls/grep on that channel and rejects the
 * mutating/network cases unless PI_CURSOR_NATIVE_EXEC=1.
 */
import { cursorEnvBoolean } from "../utils/util.js";

export const PRIVILEGED_NATIVE_EXEC = new Set([
  "shellArgs",
  "shellStreamArgs",
  "fetchArgs",
  "writeArgs",
  "deleteArgs",
]);

export function privilegedNativeExecEnabled(): boolean {
  return cursorEnvBoolean("NATIVE_EXEC", false);
}

export function isNativeExecAllowed(execCase: string): boolean {
  if (!PRIVILEGED_NATIVE_EXEC.has(execCase)) return true;
  return privilegedNativeExecEnabled();
}

export function privilegedNativeExecRejectReason(): string {
  return (
    "Privileged Cursor-native exec (shell, fetch, write, delete) is disabled in this provider. " +
    "Use Pi MCP tools instead, or set PI_CURSOR_NATIVE_EXEC=1 to restore upstream behaviour."
  );
}
