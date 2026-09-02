/**
 * PrimeAgentSessionImport - pulls prime-agent sessions recorded outside T3
 * Code into T3 threads.
 *
 * Listing scans the agent's own session directory (the same roots the usage
 * scanner reads) for top-level session JSONL files. Importing one:
 *
 * 1. finds or creates the project rooted at the session's cwd,
 * 2. creates a thread and backfills the conversation's user/assistant text
 *    through the `thread.transcript.import` command (plain
 *    `thread.message-sent` events, so every client renders it natively), and
 * 3. symlinks the original session file into the thread's per-thread session
 *    directory, where the adapter's `--session-dir` + `--continue` picks it
 *    up — the next turn continues the conversation with the agent's full
 *    native context. Because it is a symlink (copy only as a fallback), the
 *    TUI and T3 keep writing the same file, and PrimeAgentSessionSync can
 *    backfill entries the other interface adds later.
 *
 * Imports are recorded in `<stateDir>/prime-agent-imports.json` keyed by the
 * source session id, so a session imports exactly once.
 *
 * @module PrimeAgentSessionImport
 */
import * as NodeOS from "node:os";

import {
  CommandId,
  MessageId,
  type PrimeAgentImportCandidate,
  type PrimeAgentImportCandidateList,
  PrimeAgentImportError,
  type PrimeAgentImportInput,
  type PrimeAgentImportResult,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ImportedTranscriptMessage,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";

const IMPORT_REGISTRY_FILE = "prime-agent-imports.json";
/** Messages per `thread.transcript.import` dispatch; bounds one event batch. */
const IMPORT_CHUNK_SIZE = 200;
const TITLE_MAX_LENGTH = 80;

/**
 * The agent's own session root, shared with the TUI. Same resolution the
 * usage scanner uses: explicit session-dir override, else the agent home
 * override, else `~/.prime/agent/sessions`.
 */
export function resolvePrimeAgentSharedSessionDir(
  hostEnvironment: Record<string, string | undefined>,
  path: Pick<Path.Path, "resolve" | "join">,
): string {
  const primeSessionDirEnv = hostEnvironment["PRIME_AGENT_SESSION_DIR"]?.trim() ?? "";
  const primeAgentHomeEnv = hostEnvironment["PRIME_AGENT_CODING_AGENT_DIR"]?.trim() ?? "";
  const primeAgentHome =
    primeAgentHomeEnv.length > 0
      ? path.resolve(expandHomePath(primeAgentHomeEnv))
      : path.join(NodeOS.homedir(), ".prime", "agent");
  return primeSessionDirEnv.length > 0
    ? path.resolve(expandHomePath(primeSessionDirEnv))
    : path.join(primeAgentHome, "sessions");
}

export class PrimeAgentSessionImport extends Context.Service<
  PrimeAgentSessionImport,
  {
    readonly listCandidates: () => Effect.Effect<
      PrimeAgentImportCandidateList,
      PrimeAgentImportError
    >;
    readonly importSession: (
      input: PrimeAgentImportInput,
    ) => Effect.Effect<PrimeAgentImportResult, PrimeAgentImportError>;
  }
>()("t3/provider/PrimeAgentSessionImport") {}

interface ParsedPrimeSessionMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: string;
}

interface ParsedPrimeSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly parentSession: string | undefined;
  readonly rlmDepth: number;
  readonly name: string | null;
  readonly lastModelSlug: string | null;
  readonly messages: ReadonlyArray<ParsedPrimeSessionMessage>;
  /** Id of the last tree entry in the file - the parent for an appended entry. */
  readonly lastEntryId: string | null;
}

/** Thread title for a session name / first line, capped like the import. */
export function toThreadTitle(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, TITLE_MAX_LENGTH - 3)}...`
    : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tool outputs can be megabytes of logs; cap what gets rendered per block. */
const TOOL_OUTPUT_RENDER_CAP = 2_000;

function truncateOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= TOOL_OUTPUT_RENDER_CAP) {
    return trimmed;
  }
  const omitted = trimmed.length - TOOL_OUTPUT_RENDER_CAP;
  return `${trimmed.slice(0, TOOL_OUTPUT_RENDER_CAP)}\n… (+${omitted} more characters)`;
}

function fence(language: string, body: string): string {
  // Widen the fence when the body itself contains backtick runs.
  const longestRun = body.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const marker = "`".repeat(Math.max(3, longestRun + 1));
  return `${marker}${language}\n${body}\n${marker}`;
}

function quoteBlock(label: string, body: string): string {
  const quoted = body
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `> **${label}**\n${quoted}`;
}

/**
 * Renders one message's content blocks as markdown, keeping the agent's
 * actual activity visible: thinking as quotes, tool calls as code blocks.
 * Returns "" when nothing renderable is present.
 */
function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: Array<string> = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      const trimmed = item.text.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
      continue;
    }
    if (item.type === "thinking" && typeof item.thinking === "string") {
      const trimmed = item.thinking.trim();
      if (trimmed.length > 0) {
        parts.push(quoteBlock("Thinking", trimmed));
      }
      continue;
    }
    if (item.type === "toolCall" && typeof item.name === "string") {
      const args = isRecord(item.arguments) ? item.arguments : {};
      // prime-agent's primary tool is the ipython kernel; render its code
      // directly. Other tools render as name(arguments).
      if (typeof args.code === "string" && args.code.trim().length > 0) {
        parts.push(fence("python", args.code.trim()));
      } else {
        parts.push(fence("", `${item.name}(${JSON.stringify(item.arguments ?? {})})`));
      }
    }
  }
  return parts.join("\n\n").trim();
}

/** Renders a toolResult message's content as a capped output block. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? fence("", truncateOutput(trimmed)) : "";
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: Array<string> = [];
  for (const item of content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      const trimmed = item.text.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
    }
  }
  const joined = parts.join("\n\n").trim();
  return joined.length > 0 ? fence("", truncateOutput(joined)) : "";
}

/**
 * Parses one prime-agent session JSONL into the pieces the import needs.
 * Returns undefined when the file is not a session transcript (no valid
 * header line).
 */
export function parsePrimeAgentSessionFile(raw: string): ParsedPrimeSession | undefined {
  const lines = raw.split(/\r?\n/);
  let header:
    | { id: string; cwd: string; timestamp: string; parentSession?: string; rlmDepth?: number }
    | undefined;
  let name: string | null = null;
  let lastModelSlug: string | null = null;
  let lastEntryId: string | null = null;
  const messages: Array<{ role: "user" | "assistant"; text: string; timestamp: string }> = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.type !== "session" && typeof entry.id === "string") {
      lastEntryId = entry.id;
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string" && typeof entry.cwd === "string") {
        header = {
          id: entry.id,
          cwd: entry.cwd,
          timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
          ...(typeof entry.parentSession === "string"
            ? { parentSession: entry.parentSession }
            : {}),
          ...(typeof entry.rlmDepth === "number" ? { rlmDepth: entry.rlmDepth } : {}),
        };
      }
      continue;
    }
    if (entry.type === "session_info") {
      name =
        typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : null;
      continue;
    }
    if (entry.type === "model_change") {
      if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
        lastModelSlug = `${entry.provider}/${entry.modelId}`;
      }
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    const message = entry.message;
    const role = message.role;
    // A tool result belongs to the assistant message whose tool call produced
    // it: append its (capped) output to that message instead of adding a row.
    if (role === "toolResult") {
      const output = toolResultText(message.content);
      const previous = messages[messages.length - 1];
      if (output.length > 0 && previous && previous.role === "assistant") {
        previous.text = `${previous.text}\n\n${output}`;
      }
      continue;
    }
    // Commands the user ran directly in the TUI (`!command`) are part of the
    // conversation's shared context; render them as user messages.
    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command.trim() : "";
      if (command.length === 0) {
        continue;
      }
      const output = typeof message.output === "string" ? message.output.trim() : "";
      const body =
        output.length > 0
          ? `${fence("bash", command)}\n\n${fence("", truncateOutput(output))}`
          : fence("bash", command);
      messages.push({
        role: "user",
        text: body,
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    if (role === "assistant") {
      if (typeof message.provider === "string" && typeof message.model === "string") {
        lastModelSlug = `${message.provider}/${message.model}`;
      }
      // Errored assistant turns carry no durable content worth backfilling.
      if (message.stopReason === "error") {
        continue;
      }
    }
    const text = textFromContent(message.content);
    if (text.length === 0) {
      continue;
    }
    messages.push({
      role,
      text,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    });
  }

  if (!header) {
    return undefined;
  }
  return {
    sessionId: header.id,
    cwd: header.cwd,
    startedAt: header.timestamp,
    parentSession: header.parentSession,
    rlmDepth: header.rlmDepth ?? 0,
    name,
    lastModelSlug,
    messages,
    lastEntryId,
  };
}

function firstLinePreview(messages: ReadonlyArray<ParsedPrimeSessionMessage>): string | null {
  const firstUser = messages.find((message) => message.role === "user");
  if (!firstUser) {
    return null;
  }
  const firstLine = firstUser.text.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return null;
  }
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 3)}...`
    : firstLine;
}

interface ImportRegistry {
  readonly [sessionId: string]: { readonly threadId: string; readonly importedAt: string };
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* Effect.service(ServerConfig);
  const hostEnvironment = yield* HostProcessEnvironment;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

  const sessionDir = resolvePrimeAgentSharedSessionDir(hostEnvironment, path);
  const registryPath = path.join(config.stateDir, IMPORT_REGISTRY_FILE);

  const readRegistry = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(registryPath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) {
      return {} as ImportRegistry;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? (parsed as ImportRegistry) : ({} as ImportRegistry);
    } catch {
      return {} as ImportRegistry;
    }
  });

  const writeRegistry = (registry: ImportRegistry) =>
    fileSystem.writeFileString(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  const listSessionFiles = Effect.gen(function* () {
    const stack: Array<string> = [sessionDir];
    const files: Array<string> = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      const entries = yield* fileSystem
        .readDirectory(current)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const entry of entries) {
        const entryPath = path.join(current, entry);
        const info = yield* fileSystem.stat(entryPath).pipe(Effect.option);
        if (info._tag === "None") {
          continue;
        }
        if (info.value.type === "Directory") {
          stack.push(entryPath);
        } else if (entry.endsWith(".jsonl")) {
          files.push(entryPath);
        }
      }
    }
    return files;
  });

  const parseSessionAt = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.map(parsePrimeAgentSessionFile),
      Effect.orElseSucceed(() => undefined),
    );

  const listCandidates = () =>
    Effect.gen(function* () {
      const registry = yield* readRegistry;
      const files = yield* listSessionFiles;
      const candidates: Array<PrimeAgentImportCandidate> = [];
      for (const filePath of files) {
        const parsed = yield* parseSessionAt(filePath);
        if (!parsed) {
          continue;
        }
        // RLM children belong to their parent's conversation, not the picker.
        if (parsed.rlmDepth > 0 || parsed.parentSession !== undefined) {
          continue;
        }
        if (parsed.messages.length === 0) {
          continue;
        }
        const imported = registry[parsed.sessionId];
        const lastMessageAt = parsed.messages[parsed.messages.length - 1]?.timestamp ?? "";
        candidates.push({
          path: filePath,
          sessionId: parsed.sessionId,
          cwd: parsed.cwd,
          name: parsed.name,
          preview: firstLinePreview(parsed.messages),
          startedAt: parsed.startedAt || "1970-01-01T00:00:00.000Z",
          lastMessageAt: lastMessageAt.length > 0 ? lastMessageAt : null,
          messageCount: parsed.messages.length,
          importedThreadId: imported ? ThreadId.make(imported.threadId) : null,
        });
      }
      candidates.sort((left, right) =>
        (right.lastMessageAt ?? right.startedAt).localeCompare(
          left.lastMessageAt ?? left.startedAt,
        ),
      );
      return { sessions: candidates, sessionDir } satisfies PrimeAgentImportCandidateList;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new PrimeAgentImportError({
            reason: "scanFailed",
            detail: "Failed to scan prime-agent sessions.",
            cause: Cause.squash(cause),
          }),
        ),
      ),
    );

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:prime-import-${tag}:${uuid}`)),
      Effect.orDie,
    );

  const importSession = (input: PrimeAgentImportInput) =>
    Effect.gen(function* () {
      const resolvedPath = path.resolve(input.path);
      // The RPC accepts a path; only paths inside the scanned session
      // directory are importable, so a client cannot read arbitrary files.
      if (resolvedPath !== sessionDir && !resolvedPath.startsWith(`${sessionDir}${path.sep}`)) {
        return yield* new PrimeAgentImportError({
          reason: "notFound",
          detail: "Session path is outside the prime-agent session directory.",
        });
      }
      const parsed = yield* parseSessionAt(resolvedPath);
      if (!parsed) {
        return yield* new PrimeAgentImportError({
          reason: "invalidSession",
          detail: "The file is not a readable prime-agent session transcript.",
        });
      }
      if (parsed.rlmDepth > 0 || parsed.parentSession !== undefined) {
        return yield* new PrimeAgentImportError({
          reason: "invalidSession",
          detail: "RLM child sessions import with their parent, not on their own.",
        });
      }
      if (parsed.messages.length === 0) {
        return yield* new PrimeAgentImportError({
          reason: "invalidSession",
          detail: "The session has no user or assistant messages to import.",
        });
      }
      const registry = yield* readRegistry;
      const existing = registry[parsed.sessionId];
      if (existing) {
        return yield* new PrimeAgentImportError({
          reason: "alreadyImported",
          detail: `Session already imported as thread ${existing.threadId}.`,
        });
      }

      const importFailed = (detail: string) => (cause: unknown) =>
        new PrimeAgentImportError({ reason: "importFailed", detail, cause });

      const readModel = yield* projectionSnapshotQuery
        .getCommandReadModel()
        .pipe(Effect.mapError(importFailed("Failed to read the orchestration snapshot.")));
      const normalizedCwd = path.resolve(expandHomePath(parsed.cwd));
      const activeProject = readModel.projects.find(
        (project) =>
          project.deletedAt === null && path.resolve(project.workspaceRoot) === normalizedCwd,
      );

      const now = DateTime.formatIso(yield* DateTime.now);
      let projectId: ProjectId;
      if (activeProject) {
        projectId = ProjectId.make(activeProject.id);
      } else {
        projectId = ProjectId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const projectTitle = path.basename(normalizedCwd).trim() || "project";
        yield* orchestrationEngine
          .dispatch({
            type: "project.create",
            commandId: yield* commandId("project-create"),
            projectId,
            title: projectTitle,
            workspaceRoot: normalizedCwd,
            createdAt: now,
          })
          .pipe(Effect.mapError(importFailed(`Failed to create a project at ${normalizedCwd}.`)));
      }

      const threadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
      const title = toThreadTitle(
        parsed.name ?? firstLinePreview(parsed.messages) ?? "Imported session",
      );
      yield* orchestrationEngine
        .dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId,
          projectId,
          title,
          modelSelection: {
            instanceId: ProviderInstanceId.make("primeAgent"),
            model: parsed.lastModelSlug ?? "sonnet",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        })
        .pipe(Effect.mapError(importFailed("Failed to create the imported thread.")));

      const transcriptMessages: Array<ImportedTranscriptMessage> = parsed.messages.map(
        (message, index) => ({
          messageId: MessageId.make(`prime-import:${parsed.sessionId}:${index}`),
          role: message.role,
          text: message.text,
          createdAt: message.timestamp.length > 0 ? message.timestamp : now,
        }),
      );
      for (let offset = 0; offset < transcriptMessages.length; offset += IMPORT_CHUNK_SIZE) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.transcript.import",
            commandId: yield* commandId(`transcript-${offset}`),
            threadId,
            messages: transcriptMessages.slice(offset, offset + IMPORT_CHUNK_SIZE),
            createdAt: now,
          })
          .pipe(Effect.mapError(importFailed("Failed to backfill the imported transcript.")));
      }

      // Hand the original transcript to the adapter's per-thread session dir;
      // the next turn spawns with `--continue` and the agent resumes with its
      // full native context. A symlink keeps the TUI and T3 on the same file
      // (shared history both ways); copy stays as the fallback for
      // filesystems that refuse symlinks.
      const threadSessionDir = path.join(config.stateDir, "prime-agent-sessions", threadId);
      const linkTarget = path.join(threadSessionDir, path.basename(resolvedPath));
      yield* fileSystem.makeDirectory(threadSessionDir, { recursive: true }).pipe(
        Effect.flatMap(() =>
          fileSystem
            .symlink(resolvedPath, linkTarget)
            .pipe(Effect.catch(() => fileSystem.copyFile(resolvedPath, linkTarget))),
        ),
        Effect.mapError(importFailed("Failed to link the session file to the thread.")),
      );

      yield* writeRegistry({
        ...registry,
        [parsed.sessionId]: { threadId, importedAt: now },
      }).pipe(Effect.mapError(importFailed("Failed to record the import registry.")));

      return {
        threadId,
        projectId,
        importedMessages: transcriptMessages.length,
      } satisfies PrimeAgentImportResult;
    }).pipe(
      Effect.catch((error) =>
        Effect.fail(
          error instanceof PrimeAgentImportError
            ? error
            : new PrimeAgentImportError({
                reason: "importFailed",
                detail: "Import failed unexpectedly.",
                cause: error,
              }),
        ),
      ),
    );

  return PrimeAgentSessionImport.of({ listCandidates, importSession });
});

export const layer = Layer.effect(PrimeAgentSessionImport, make);
