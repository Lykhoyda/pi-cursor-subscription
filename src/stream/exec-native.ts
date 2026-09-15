/**
 * In-stream handlers for Cursor's native exec channel (read, ls, grep, write,
 * delete, shell, fetch). These run on the open Run RPC so the model can keep
 * generating instead of being told to retry through MCP.
 *
 * Privileged cases (write, delete, shell, fetch) are gated by
 * `PI_CURSOR_NATIVE_EXEC` — off by default in this fork. Paths for the
 * remaining handlers are confined to `process.cwd()`.
 */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type IncomingHttpHeaders, type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import path from "node:path";

import { create } from "@bufbuild/protobuf";

import {
  DeleteErrorSchema,
  DeleteFileNotFoundSchema,
  DeleteNotFileSchema,
  DeletePermissionDeniedSchema,
  DeleteResultSchema,
  DeleteSuccessSchema,
  DiagnosticsResultSchema,
  DiagnosticsSuccessSchema,
  FetchErrorSchema,
  FetchResultSchema,
  FetchSuccessSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepErrorSchema,
  GrepFileMatchSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesSuccessSchema,
  LsDirectoryTreeNode_FileSchema,
  LsDirectoryTreeNodeSchema,
  LsErrorSchema,
  LsRejectedSchema,
  LsResultSchema,
  LsSuccessSchema,
  ReadErrorSchema,
  ReadFileNotFoundSchema,
  ReadPermissionDeniedSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  ShellFailureSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStderrSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  WriteErrorSchema,
  WritePermissionDeniedSchema,
  WriteResultSchema,
  WriteSuccessSchema,
} from "../proto/agent_pb.js";

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
]);

const MAX_READ_BYTES = 512 * 1024;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES = 400;
const MAX_LS_ENTRIES = 200;
const MAX_SHELL_OUTPUT_BYTES = 512 * 1024;
const MAX_FETCH_BYTES = 1024 * 1024;
const SHELL_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_FETCH_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * IANA special-purpose address space (RFC 6890 registries) plus multicast:
 * loopback, RFC1918, CGNAT, link-local (incl. cloud metadata), unspecified,
 * TEST-NETs, benchmarking, IETF assignments, 6to4 / NAT64 embeds, ULA, discard.
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is matched against the IPv4 rules by BlockList.
 */
const PRIVATE_NETS = new BlockList();
for (const [addr, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
] as const) {
  PRIVATE_NETS.addSubnet(addr, prefix, family);
}

export type NativeExecFrame = { resultCase: string; value: unknown };

export type NativeExecDispatch =
  | { kind: "sync"; frame: NativeExecFrame }
  | { kind: "async"; run: () => Promise<NativeExecFrame> }
  | { kind: "stream"; run: (emit: (frame: NativeExecFrame) => void) => Promise<void> };

export function emptyGrepPatternRejection(
  pattern: string | undefined,
  glob: string | undefined,
): string | null {
  if (typeof pattern === "string" && pattern.length > 0) return null;
  if (glob) {
    return `Grep pattern is empty (glob=${glob}). Supply a regex pattern, or use ls/read instead of grep-as-glob.`;
  }
  return "Grep pattern must not be empty.";
}

export function resolveInWorkspace(
  inputPath: string | undefined,
): { path: string } | { error: string; code: "denied" | "invalid" } {
  let root: string;
  try {
    root = realpathSync(process.cwd());
  } catch {
    root = path.resolve(process.cwd());
  }
  const candidate = path.resolve(root, inputPath && inputPath.length > 0 ? inputPath : ".");
  let comparable = candidate;
  try {
    let ancestor = candidate;
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    comparable = path.join(realpathSync(ancestor), path.relative(ancestor, candidate));
  } catch {
    comparable = candidate;
  }
  const relative = path.relative(root, comparable);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { error: `Path is outside the workspace: ${inputPath ?? "."}`, code: "denied" };
  }
  return { path: candidate };
}

function displayPath(absPath: string): string {
  const relative = path.relative(process.cwd(), absPath);
  return relative.length > 0 ? relative : ".";
}

function isSkippedDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name);
}

export function dispatchNativeExec(
  execCase: string,
  args: Record<string, unknown>,
): NativeExecDispatch | undefined {
  switch (execCase) {
    case "readArgs":
      return { kind: "sync", frame: execRead(args) };
    case "lsArgs":
      return { kind: "sync", frame: execLs(args) };
    case "grepArgs":
      return { kind: "sync", frame: execGrep(args) };
    case "writeArgs":
      return { kind: "sync", frame: execWrite(args) };
    case "deleteArgs":
      return { kind: "sync", frame: execDelete(args) };
    case "diagnosticsArgs":
      return { kind: "sync", frame: execDiagnostics(args) };
    case "listMcpResourcesExecArgs":
      return {
        kind: "sync",
        frame: {
          resultCase: "listMcpResourcesExecResult",
          value: create(ListMcpResourcesExecResultSchema, {
            result: {
              case: "success",
              value: create(ListMcpResourcesSuccessSchema, { resources: [] }),
            },
          }),
        },
      };
    case "shellArgs":
      return { kind: "async", run: () => execShell(args) };
    case "shellStreamArgs":
      return { kind: "stream", run: (emit) => execShellStream(args, emit) };
    case "fetchArgs":
      return { kind: "async", run: () => execFetch(args) };
    default:
      return undefined;
  }
}

function execRead(args: Record<string, unknown>): NativeExecFrame {
  const rawPath = typeof args.path === "string" ? args.path : "";
  const resolved = resolveInWorkspace(rawPath);
  if ("error" in resolved) {
    return {
      resultCase: "readResult",
      value: create(ReadResultSchema, {
        result: {
          case: "permissionDenied",
          value: create(ReadPermissionDeniedSchema, { path: rawPath }),
        },
      }),
    };
  }
  if (!existsSync(resolved.path)) {
    return {
      resultCase: "readResult",
      value: create(ReadResultSchema, {
        result: {
          case: "fileNotFound",
          value: create(ReadFileNotFoundSchema, { path: rawPath }),
        },
      }),
    };
  }
  try {
    const stat = statSync(resolved.path);
    if (!stat.isFile()) {
      return {
        resultCase: "readResult",
        value: create(ReadResultSchema, {
          result: {
            case: "error",
            value: create(ReadErrorSchema, { path: rawPath, error: "Not a file" }),
          },
        }),
      };
    }
    const offset = Number(args.offset);
    const limit = Number(args.limit);
    const raw = readFileSync(resolved.path);
    const truncatedFile = raw.byteLength > MAX_READ_BYTES;
    const text = raw.subarray(0, MAX_READ_BYTES).toString("utf8");
    const lines = text.split("\n");
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) - 1 : 0;
    const count = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : lines.length;
    const slice = lines.slice(Math.max(0, start), Math.max(0, start) + count);
    const content = slice.join("\n");
    return {
      resultCase: "readResult",
      value: create(ReadResultSchema, {
        result: {
          case: "success",
          value: create(ReadSuccessSchema, {
            path: displayPath(resolved.path),
            totalLines: lines.length,
            fileSize: BigInt(stat.size),
            truncated: truncatedFile || start + count < lines.length,
            output: { case: "content", value: content },
          }),
        },
      }),
    };
  } catch (error) {
    return {
      resultCase: "readResult",
      value: create(ReadResultSchema, {
        result: {
          case: "error",
          value: create(ReadErrorSchema, {
            path: rawPath,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    };
  }
}

function execLs(args: Record<string, unknown>): NativeExecFrame {
  const rawPath = typeof args.path === "string" ? args.path : ".";
  const resolved = resolveInWorkspace(rawPath);
  if ("error" in resolved) {
    return {
      resultCase: "lsResult",
      value: create(LsResultSchema, {
        result: {
          case: "rejected",
          value: create(LsRejectedSchema, { path: rawPath, reason: resolved.error }),
        },
      }),
    };
  }
  try {
    const target = existsSync(resolved.path) ? realpathSync(resolved.path) : resolved.path;
    const stat = statSync(target);
    if (!stat.isDirectory()) {
      return {
        resultCase: "lsResult",
        value: create(LsResultSchema, {
          result: {
            case: "error",
            value: create(LsErrorSchema, { path: rawPath, error: "Not a directory" }),
          },
        }),
      };
    }
    const entries = readdirSync(target, { withFileTypes: true });
    const dirs: ReturnType<typeof create>[] = [];
    const files: ReturnType<typeof create>[] = [];
    let processed = 0;
    for (const entry of entries) {
      if (processed >= MAX_LS_ENTRIES) break;
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) continue;
        dirs.push(
          create(LsDirectoryTreeNodeSchema, {
            absPath: path.join(target, entry.name),
            childrenWereProcessed: false,
          }),
        );
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(create(LsDirectoryTreeNode_FileSchema, { name: entry.name }));
      }
      processed += 1;
    }
    return {
      resultCase: "lsResult",
      value: create(LsResultSchema, {
        result: {
          case: "success",
          value: create(LsSuccessSchema, {
            directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
              absPath: target,
              childrenDirs: dirs as never,
              childrenFiles: files as never,
              childrenWereProcessed: true,
            }),
          }),
        },
      }),
    };
  } catch (error) {
    return {
      resultCase: "lsResult",
      value: create(LsResultSchema, {
        result: {
          case: "error",
          value: create(LsErrorSchema, {
            path: rawPath,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    };
  }
}

function execGrep(args: Record<string, unknown>): NativeExecFrame {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const glob = typeof args.glob === "string" ? args.glob : undefined;
  const empty = emptyGrepPatternRejection(pattern, glob);
  if (empty) {
    return {
      resultCase: "grepResult",
      value: create(GrepResultSchema, {
        result: { case: "error", value: create(GrepErrorSchema, { error: empty }) },
      }),
    };
  }
  const rawPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
  const resolved = resolveInWorkspace(rawPath);
  if ("error" in resolved) {
    return {
      resultCase: "grepResult",
      value: create(GrepResultSchema, {
        result: { case: "error", value: create(GrepErrorSchema, { error: resolved.error }) },
      }),
    };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, args.caseInsensitive === true ? "i" : "");
  } catch (error) {
    return {
      resultCase: "grepResult",
      value: create(GrepResultSchema, {
        result: {
          case: "error",
          value: create(GrepErrorSchema, {
            error: error instanceof Error ? error.message : "Invalid grep pattern",
          }),
        },
      }),
    };
  }
  const matches: Array<{ file: string; lines: Array<{ lineNumber: number; content: string }> }> =
    [];
  let truncated = false;
  let totalMatchedLines = 0;
  walkFiles(resolved.path, glob, (filePath) => {
    if (matches.length >= MAX_GREP_FILES || totalMatchedLines >= MAX_GREP_MATCHES) {
      truncated = true;
      return false;
    }
    let text: string;
    try {
      const stat = statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_GREP_FILE_BYTES) return true;
      const buf = readFileSync(filePath);
      if (buf.includes(0)) return true;
      text = buf.toString("utf8");
    } catch {
      return true;
    }
    const fileMatches: Array<{ lineNumber: number; content: string }> = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!regex.test(lines[i]!)) continue;
      fileMatches.push({ lineNumber: i + 1, content: lines[i]!.slice(0, 500) });
      totalMatchedLines += 1;
      if (totalMatchedLines >= MAX_GREP_MATCHES) {
        truncated = true;
        break;
      }
    }
    if (fileMatches.length > 0) {
      matches.push({ file: displayPath(filePath), lines: fileMatches });
    }
    return true;
  });
  const workspaceResults: Record<string, ReturnType<typeof create>> = {};
  for (const file of matches) {
    workspaceResults[file.file] = create(GrepUnionResultSchema, {
      result: {
        case: "content",
        value: create(GrepContentResultSchema, {
          matches: [
            create(GrepFileMatchSchema, {
              file: file.file,
              matches: file.lines.map((line) =>
                create(GrepContentMatchSchema, {
                  lineNumber: line.lineNumber,
                  content: line.content,
                  contentTruncated: false,
                  isContextLine: false,
                }),
              ),
            }),
          ],
          totalLines: file.lines.length,
          totalMatchedLines: file.lines.length,
          clientTruncated: truncated,
          ripgrepTruncated: false,
        }),
      },
    });
  }
  return {
    resultCase: "grepResult",
    value: create(GrepResultSchema, {
      result: {
        case: "success",
        value: create(GrepSuccessSchema, {
          pattern,
          path: displayPath(resolved.path),
          outputMode: "content",
          workspaceResults: workspaceResults as never,
        }),
      },
    }),
  };
}

function execWrite(args: Record<string, unknown>): NativeExecFrame {
  const rawPath = typeof args.path === "string" ? args.path : "";
  const resolved = resolveInWorkspace(rawPath);
  if ("error" in resolved) {
    return {
      resultCase: "writeResult",
      value: create(WriteResultSchema, {
        result: {
          case: "permissionDenied",
          value: create(WritePermissionDeniedSchema, {
            path: rawPath,
            directory: path.dirname(rawPath || "."),
            operation: "write",
            error: resolved.error,
          }),
        },
      }),
    };
  }
  const content =
    typeof args.fileText === "string"
      ? args.fileText
      : args.fileBytes instanceof Uint8Array
        ? new TextDecoder().decode(args.fileBytes)
        : "";
  try {
    mkdirSync(path.dirname(resolved.path), { recursive: true });
    writeFileSync(resolved.path, content, "utf8");
    const stat = statSync(resolved.path);
    const linesCreated = content.length === 0 ? 0 : content.split("\n").length;
    return {
      resultCase: "writeResult",
      value: create(WriteResultSchema, {
        result: {
          case: "success",
          value: create(WriteSuccessSchema, {
            path: displayPath(resolved.path),
            linesCreated,
            fileSize: Number(stat.size),
            ...(args.returnFileContentAfterWrite === true
              ? { fileContentAfterWrite: content }
              : {}),
          }),
        },
      }),
    };
  } catch (error) {
    return {
      resultCase: "writeResult",
      value: create(WriteResultSchema, {
        result: {
          case: "error",
          value: create(WriteErrorSchema, {
            path: rawPath,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    };
  }
}

function execDelete(args: Record<string, unknown>): NativeExecFrame {
  const rawPath = typeof args.path === "string" ? args.path : "";
  const resolved = resolveInWorkspace(rawPath);
  if ("error" in resolved) {
    return {
      resultCase: "deleteResult",
      value: create(DeleteResultSchema, {
        result: {
          case: "permissionDenied",
          value: create(DeletePermissionDeniedSchema, {
            path: rawPath,
            clientVisibleError: resolved.error,
            isReadonly: false,
          }),
        },
      }),
    };
  }
  if (!existsSync(resolved.path)) {
    return {
      resultCase: "deleteResult",
      value: create(DeleteResultSchema, {
        result: {
          case: "fileNotFound",
          value: create(DeleteFileNotFoundSchema, { path: rawPath }),
        },
      }),
    };
  }
  try {
    const stat = lstatSync(resolved.path);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return {
        resultCase: "deleteResult",
        value: create(DeleteResultSchema, {
          result: {
            case: "notFile",
            value: create(DeleteNotFileSchema, { path: rawPath, actualType: "directory" }),
          },
        }),
      };
    }
    const prev = stat.isFile() ? readFileSync(resolved.path, "utf8").slice(0, 16_384) : "";
    unlinkSync(resolved.path);
    return {
      resultCase: "deleteResult",
      value: create(DeleteResultSchema, {
        result: {
          case: "success",
          value: create(DeleteSuccessSchema, {
            path: displayPath(resolved.path),
            deletedFile: displayPath(resolved.path),
            fileSize: BigInt(stat.size),
            prevContent: prev,
          }),
        },
      }),
    };
  } catch (error) {
    return {
      resultCase: "deleteResult",
      value: create(DeleteResultSchema, {
        result: {
          case: "error",
          value: create(DeleteErrorSchema, {
            path: rawPath,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      }),
    };
  }
}

function execDiagnostics(args: Record<string, unknown>): NativeExecFrame {
  const rawPath = typeof args.path === "string" ? args.path : "";
  return {
    resultCase: "diagnosticsResult",
    value: create(DiagnosticsResultSchema, {
      result: {
        case: "success",
        value: create(DiagnosticsSuccessSchema, {
          path: rawPath,
          diagnostics: [],
          totalDiagnostics: 0,
        }),
      },
    }),
  };
}

async function execShell(args: Record<string, unknown>): Promise<NativeExecFrame> {
  const command = typeof args.command === "string" ? args.command : "";
  const workingDirectory =
    typeof args.workingDirectory === "string" && args.workingDirectory.length > 0
      ? args.workingDirectory
      : process.cwd();
  const cwdResolved = resolveInWorkspace(workingDirectory);
  if ("error" in cwdResolved) {
    return {
      resultCase: "shellResult",
      value: create(ShellResultSchema, {
        result: {
          case: "rejected",
          value: create(ShellRejectedSchema, {
            command,
            workingDirectory,
            reason: cwdResolved.error,
            isReadonly: false,
          }),
        },
      }),
    };
  }
  if (!command.trim()) {
    return {
      resultCase: "shellResult",
      value: create(ShellResultSchema, {
        result: {
          case: "failure",
          value: create(ShellFailureSchema, {
            command,
            workingDirectory: cwdResolved.path,
            stdout: "",
            stderr: "Empty command",
            exitCode: 1,
            signal: "",
            executionTime: 0,
          }),
        },
      }),
    };
  }
  const started = Date.now();
  const result = await runShellCommand(command, cwdResolved.path, SHELL_TIMEOUT_MS);
  const executionTime = Date.now() - started;
  if (result.exitCode === 0) {
    return {
      resultCase: "shellResult",
      value: create(ShellResultSchema, {
        result: {
          case: "success",
          value: create(ShellSuccessSchema, {
            command,
            workingDirectory: cwdResolved.path,
            exitCode: 0,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            executionTime,
            interleavedOutput: result.stdout,
          }),
        },
      }),
    };
  }
  return {
    resultCase: "shellResult",
    value: create(ShellResultSchema, {
      result: {
        case: "failure",
        value: create(ShellFailureSchema, {
          command,
          workingDirectory: cwdResolved.path,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
          executionTime,
        }),
      },
    }),
  };
}

async function execShellStream(
  args: Record<string, unknown>,
  emit: (frame: NativeExecFrame) => void,
): Promise<void> {
  const command = typeof args.command === "string" ? args.command : "";
  const workingDirectory =
    typeof args.workingDirectory === "string" && args.workingDirectory.length > 0
      ? args.workingDirectory
      : process.cwd();
  const cwdResolved = resolveInWorkspace(workingDirectory);
  if ("error" in cwdResolved) {
    emit({
      resultCase: "shellStream",
      value: create(ShellStreamSchema, {
        event: {
          case: "rejected",
          value: create(ShellRejectedSchema, {
            command,
            workingDirectory,
            reason: cwdResolved.error,
            isReadonly: false,
          }),
        },
      }),
    });
    return;
  }
  emit({
    resultCase: "shellStream",
    value: create(ShellStreamSchema, {
      event: { case: "start", value: create(ShellStreamStartSchema, {}) },
    }),
  });
  const result = await runShellCommand(command, cwdResolved.path, SHELL_TIMEOUT_MS);
  if (result.stdout) {
    emit({
      resultCase: "shellStream",
      value: create(ShellStreamSchema, {
        event: { case: "stdout", value: create(ShellStreamStdoutSchema, { data: result.stdout }) },
      }),
    });
  }
  if (result.stderr) {
    emit({
      resultCase: "shellStream",
      value: create(ShellStreamSchema, {
        event: { case: "stderr", value: create(ShellStreamStderrSchema, { data: result.stderr }) },
      }),
    });
  }
  emit({
    resultCase: "shellStream",
    value: create(ShellStreamSchema, {
      event: {
        case: "exit",
        value: create(ShellStreamExitSchema, {
          code: result.exitCode,
          cwd: cwdResolved.path,
          aborted: result.timedOut,
        }),
      },
    }),
  });
}

async function execFetch(args: Record<string, unknown>): Promise<NativeExecFrame> {
  const url = typeof args.url === "string" ? args.url : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fetchError(url, "Invalid URL");
  }
  try {
    const response = await fetchPublic(parsed);
    const truncated = response.body.byteLength > MAX_FETCH_BYTES;
    const content = response.body.subarray(0, MAX_FETCH_BYTES).toString("utf8");
    return {
      resultCase: "fetchResult",
      value: create(FetchResultSchema, {
        result: {
          case: "success",
          value: create(FetchSuccessSchema, {
            url,
            content: truncated ? `${content}\n\n[truncated]` : content,
            statusCode: response.status,
            contentType: response.headers["content-type"] ?? "",
          }),
        },
      }),
    };
  } catch (error) {
    return fetchError(url, error instanceof Error ? error.message : String(error));
  }
}

export interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type PinnedRequest = (url: URL, address: string, signal: AbortSignal) => Promise<PinnedResponse>;

/**
 * Follows redirects by hand so every hop is re-checked against the scheme and
 * private-address rules; a public URL must not be able to bounce into the LAN.
 * The address that passed the check is the one the socket connects to.
 */
export async function fetchPublic(
  url: URL,
  request: PinnedRequest = requestPinned,
): Promise<PinnedResponse> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let target = url;
  for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("Only http and https URLs can be fetched");
    }
    const response = await request(target, await resolvePublicAddress(target), signal);
    const location = response.headers.location;
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    target = new URL(location, target);
  }
  throw new Error(`Too many redirects (max ${MAX_FETCH_REDIRECTS})`);
}

async function resolvePublicAddress(url: URL): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((entry) => entry.address);
  const blocked = addresses.some((address) =>
    PRIVATE_NETS.check(address, isIP(address) === 6 ? "ipv6" : "ipv4"),
  );
  if (blocked || addresses.length === 0) {
    throw new Error(`Refusing to fetch private or internal address for host ${url.hostname}`);
  }
  return addresses[0];
}

/**
 * Connects to `address` (no second DNS lookup) while keeping the URL's host for
 * the Host header, SNI, and certificate identity, so a rebinding name cannot
 * swap in an internal address between the check and the connect.
 */
export async function requestPinned(
  url: URL,
  address: string,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const secure = url.protocol === "https:";
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    (secure ? httpsRequest : httpRequest)(
      {
        host: address,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        servername: secure && !isIP(hostname) ? hostname : undefined,
        headers: { host: url.host },
        signal,
      },
      resolve,
    )
      .on("error", reject)
      .end();
  });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_FETCH_BYTES) break;
  }
  return { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) };
}

function fetchError(url: string, error: string): NativeExecFrame {
  return {
    resultCase: "fetchResult",
    value: create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url, error }) },
    }),
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function walkFiles(
  root: string,
  glob: string | undefined,
  visit: (filePath: string) => boolean,
): void {
  const matcher = glob ? globToRegExp(glob) : undefined;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      const stat = statSync(current);
      if (stat.isFile()) {
        if (!matcher || matcher.test(path.basename(current))) {
          if (!visit(current)) return;
        }
        continue;
      }
      if (!stat.isDirectory()) continue;
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) continue;
        stack.push(path.join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (matcher && !matcher.test(entry.name)) continue;
      if (!visit(path.join(current, entry.name))) return;
    }
  }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}\n\n[truncated]`;
}

/** Env var names that must not reach a model-controlled shell (covers CURSOR_ACCESS_TOKEN). */
const SECRET_ENV_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL/i;

export function shellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV_KEY.test(key)));
}

/**
 * The command itself is not confined — only its starting cwd is workspace-checked
 * (`cd /` works). Env is scrubbed of secret-looking names and the timeout SIGKILLs
 * the whole process group so `trap '' TERM` or a backgrounded grandchild cannot
 * outlive it or hold the stdout pipe open.
 */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string;
  timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(
      isWin ? "cmd.exe" : "/bin/sh",
      isWin ? ["/d", "/s", "/c", command] : ["-c", command],
      {
        cwd,
        env: shellEnv(),
        windowsHide: true,
        detached: !isWin,
      },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // ponytail: Windows kills cmd.exe only; use taskkill /T if orphaned children matter there.
      if (isWin || child.pid === undefined) {
        child.kill();
        return;
      }
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_SHELL_OUTPUT_BYTES) {
        stdout = truncateUtf8(stdout, MAX_SHELL_OUTPUT_BYTES);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr, "utf8") > MAX_SHELL_OUTPUT_BYTES) {
        stderr = truncateUtf8(stderr, MAX_SHELL_OUTPUT_BYTES);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: error.message,
        exitCode: 1,
        signal: "",
        timedOut,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        signal: signal ?? "",
        timedOut,
      });
    });
  });
}
