/**
 * PrimeAgentSessionSync - keeps a T3 thread and its prime-agent session file
 * (shared with the TUI) telling the same story.
 *
 * A thread's session file lives in the agent's own shared session directory;
 * the per-thread dir under `<stateDir>/prime-agent-sessions/<threadId>` holds
 * a symlink to it. Entries can therefore be appended by either interface.
 * This service backfills entries T3 has not displayed yet as
 * `thread.transcript.import` messages with the same deterministic ids the
 * initial import uses (`prime-import:<sessionId>:<index>`), so re-sends are
 * idempotent upserts.
 *
 * Names travel both ways: the file's latest `session_info` name becomes the
 * thread title, and a T3 title change is appended to the file as a
 * `session_info` entry so the TUI shows the same name.
 *
 * Deleting a thread deletes its session: the shared file (and its artifacts)
 * for linked threads, only the private copy for threads that never linked.
 *
 * Trigger points:
 * - before every T3 turn (write safety: sync first, then prompt),
 * - after every T3 turn (advance the cursor past our own turn's entries
 *   without re-importing them - they already rendered natively),
 * - a watcher on the shared session directory (TUI activity shows up in the
 *   open thread without waiting for the next turn),
 * - `thread.meta-updated` events carrying a title (T3 -> file name),
 * - `thread.deleted` via ThreadDeletionReactor (`forgetThread`).
 *
 * Cursor state lives in `<stateDir>/prime-agent-sync.json` keyed by thread.
 * A missing cursor initializes from the thread's existing `prime-import:`
 * message ids (imported threads), else from the current file length
 * (T3-native threads - their history is already rendered as native turns).
 *
 * ponytail: entries another interface writes while a T3 turn is mid-flight
 * are skipped by the post-turn cursor advance; driving both interfaces into
 * one session at the same instant is the case the pre-turn sync refuses to
 * make worse, not one it can merge.
 *
 * @module PrimeAgentSessionSync
 */
import { randomUUID } from "node:crypto";

import { CommandId, MessageId, ThreadId, type ImportedTranscriptMessage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  parsePrimeAgentSessionFile,
  resolvePrimeAgentSharedSessionDir,
  toThreadTitle,
} from "./PrimeAgentSessionImport.ts";

const SYNC_STATE_FILE = "prime-agent-sync.json";
const IMPORT_REGISTRY_FILE = "prime-agent-imports.json";
const SYNC_CHUNK_SIZE = 200;
const MESSAGE_ID_PREFIX = "prime-import";

type ParsedSession = NonNullable<ReturnType<typeof parsePrimeAgentSessionFile>>;

interface ThreadSyncState {
  readonly sessionId: string;
  readonly syncedMessageCount: number;
  /**
   * Whether the message at `syncedMessageCount - 1` exists as an imported
   * (`prime-import:`) row. Only then may a later sync re-send it as the
   * healing upsert; re-sending a natively rendered message would duplicate
   * it under a new id.
   */
  readonly tailImported: boolean;
  /**
   * A T3 title waiting to be written into the file. prime-agent rewrites the
   * whole file until the first assistant message lands, so an append before
   * that would be lost; it is flushed on the next sync / turn completion.
   */
  readonly pendingName?: string;
}

interface SyncStateFile {
  readonly [threadId: string]: ThreadSyncState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PrimeAgentSessionSync extends Context.Service<
  PrimeAgentSessionSync,
  {
    /**
     * Backfills unseen session-file entries into the thread and mirrors the
     * file's session name into the thread title. No-ops for threads without
     * a prime-agent session file. Called before every turn (write safety:
     * the turn proceeds only after T3 has caught up) and by the
     * shared-directory watcher.
     */
    readonly syncThread: (threadId: ThreadId) => Effect.Effect<number>;
    /**
     * Advances the cursor to the current end of the file without importing:
     * the entries a T3 turn just appended are already rendered natively.
     */
    readonly noteTurnCompleted: (threadId: ThreadId) => Effect.Effect<void>;
    /**
     * Writes a T3 title into the session file as a `session_info` entry so
     * the TUI shows the same name. Driven by `thread.meta-updated` events.
     */
    readonly noteTitleChanged: (threadId: ThreadId, title: string) => Effect.Effect<void>;
    /**
     * Removes a deleted thread's session: the shared file and its artifacts
     * when the thread was linked to it, only the private copy otherwise,
     * plus the sync cursor and import-registry entry.
     */
    readonly forgetThread: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/provider/PrimeAgentSessionSync") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* Effect.service(ServerConfig);
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const semaphore = yield* Semaphore.make(1);

  const threadsRoot = path.join(config.stateDir, "prime-agent-sessions");
  const statePath = path.join(config.stateDir, SYNC_STATE_FILE);
  const registryPath = path.join(config.stateDir, IMPORT_REGISTRY_FILE);

  const readJsonObject = (filePath: string) =>
    Effect.gen(function* () {
      const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
      if (raw.trim().length === 0) {
        return {} as Record<string, unknown>;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        return isRecord(parsed) ? parsed : ({} as Record<string, unknown>);
      } catch {
        return {} as Record<string, unknown>;
      }
    });

  const writeJsonObject = (filePath: string, value: Record<string, unknown>) =>
    fileSystem.writeFileString(filePath, `${JSON.stringify(value, null, 2)}\n`);

  const readState = readJsonObject(statePath).pipe(Effect.map((value) => value as SyncStateFile));
  const writeState = (state: SyncStateFile) => writeJsonObject(statePath, { ...state });

  /** The thread's session file (symlink resolved), or undefined. */
  const findThreadSessionFile = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const threadDir = path.join(threadsRoot, threadId);
      const entries = yield* fileSystem
        .readDirectory(threadDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      const sessionEntry = [...entries].sort().find((entry) => entry.endsWith(".jsonl"));
      if (!sessionEntry) {
        return undefined;
      }
      const linkPath = path.join(threadDir, sessionEntry);
      return yield* fileSystem.realPath(linkPath).pipe(Effect.orElseSucceed(() => linkPath));
    });

  const parseSessionAt = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(
      Effect.map(parsePrimeAgentSessionFile),
      Effect.orElseSucceed(() => undefined),
    );

  const readThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getCommandReadModel().pipe(
      Effect.map((readModel) => readModel.threads.find((entry) => entry.id === threadId)),
      Effect.orElseSucceed(() => undefined),
    );

  type ReadModelThread = NonNullable<Effect.Success<ReturnType<typeof readThread>>>;

  /**
   * Where the cursor starts for a thread that has no recorded state.
   * Imported threads resume after their highest imported index; native
   * threads start at the current end of file (their history already rendered
   * as native turn messages - re-importing it would duplicate every row).
   */
  const initialCursor = (
    thread: ReadModelThread | undefined,
    sessionId: string,
    messageCount: number,
  ) => {
    let highestImportedIndex = -1;
    const idPrefix = `${MESSAGE_ID_PREFIX}:${sessionId}:`;
    for (const message of thread?.messages ?? []) {
      if (!message.id.startsWith(idPrefix)) {
        continue;
      }
      const index = Number.parseInt(message.id.slice(idPrefix.length), 10);
      if (Number.isFinite(index) && index > highestImportedIndex) {
        highestImportedIndex = index;
      }
    }
    if (highestImportedIndex >= 0) {
      return { cursor: highestImportedIndex + 1, tailImported: true };
    }
    return { cursor: messageCount, tailImported: false };
  };

  const isThreadTurnActive = (threadId: ThreadId) =>
    readThread(threadId).pipe(
      Effect.map((thread) => {
        const session = thread?.session;
        return session?.status === "running" || session?.activeTurnId != null;
      }),
    );

  const hasAssistantMessage = (parsed: ParsedSession) =>
    parsed.messages.some((message) => message.role === "assistant");

  /** Appends a `session_info` entry shaped like prime-agent's own. */
  const appendSessionName = (sessionFile: string, parsed: ParsedSession, name: string) =>
    Effect.gen(function* () {
      const entry = {
        type: "session_info",
        id: randomUUID().slice(0, 8),
        parentId: parsed.lastEntryId,
        timestamp: DateTime.formatIso(yield* DateTime.now),
        name,
      };
      yield* fileSystem.writeFileString(sessionFile, `${JSON.stringify(entry)}\n`, { flag: "a" });
    });

  /**
   * Writes a title that was waiting for the file to hold an assistant
   * message. Returns the file's effective name and what is still pending.
   */
  const flushPendingName = (
    sessionFile: string,
    parsed: ParsedSession,
    recorded: ThreadSyncState | undefined,
  ) =>
    Effect.gen(function* () {
      const pendingName = recorded?.pendingName;
      if (pendingName === undefined || !hasAssistantMessage(parsed)) {
        return { name: parsed.name, pendingName };
      }
      yield* appendSessionName(sessionFile, parsed, pendingName);
      return { name: pendingName, pendingName: undefined };
    });

  const syncThreadLocked = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const sessionFile = yield* findThreadSessionFile(threadId);
      if (!sessionFile) {
        return 0;
      }
      const parsed = yield* parseSessionAt(sessionFile);
      if (!parsed) {
        return 0;
      }
      const thread = yield* readThread(threadId);
      const state = yield* readState;
      const recorded = state[threadId];
      const resumed =
        recorded && recorded.sessionId === parsed.sessionId
          ? { cursor: recorded.syncedMessageCount, tailImported: recorded.tailImported === true }
          : initialCursor(thread, parsed.sessionId, parsed.messages.length);
      // Re-send the last already-imported message: tool outputs append to it
      // after the fact, and the deterministic id makes this a plain upsert.
      // A natively rendered tail must never re-send - it has no imported row
      // to update, so the re-send would show up as a duplicate.
      const from = resumed.tailImported ? Math.max(0, resumed.cursor - 1) : resumed.cursor;
      const now = DateTime.formatIso(yield* DateTime.now);
      const pending: Array<ImportedTranscriptMessage> = [];
      for (let index = from; index < parsed.messages.length; index += 1) {
        const message = parsed.messages[index];
        if (!message) {
          continue;
        }
        pending.push({
          messageId: MessageId.make(`${MESSAGE_ID_PREFIX}:${parsed.sessionId}:${index}`),
          role: message.role,
          text: message.text,
          createdAt: message.timestamp.length > 0 ? message.timestamp : now,
        });
      }
      const importedCount = Math.max(0, parsed.messages.length - resumed.cursor);
      for (let offset = 0; offset < pending.length; offset += SYNC_CHUNK_SIZE) {
        const chunk = pending.slice(offset, offset + SYNC_CHUNK_SIZE);
        const first = from + offset;
        yield* orchestrationEngine
          .dispatch({
            type: "thread.transcript.import",
            // Deterministic per content range: a retried sync replays the
            // stored receipt instead of appending duplicate events.
            commandId: CommandId.make(
              `server:prime-sync:${parsed.sessionId}:${first}-${first + chunk.length}`,
            ),
            threadId,
            messages: chunk,
            createdAt: now,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("PrimeAgent session sync dispatch failed.", { cause }),
            ),
          );
      }

      // Names: a pending T3 title goes into the file first; then the file's
      // name (whoever set it last) is what the thread shows.
      const named = yield* flushPendingName(sessionFile, parsed, recorded);
      if (thread && named.name) {
        const title = toThreadTitle(named.name);
        if (title.length > 0 && title !== thread.title) {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make(`server:prime-sync-title:${randomUUID()}`),
              threadId,
              title,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("PrimeAgent session sync title update failed.", { cause }),
              ),
            );
        }
      }

      const nextTailImported = importedCount > 0 ? true : resumed.tailImported;
      if (
        !recorded ||
        recorded.sessionId !== parsed.sessionId ||
        recorded.syncedMessageCount !== parsed.messages.length ||
        recorded.tailImported !== nextTailImported ||
        recorded.pendingName !== named.pendingName
      ) {
        yield* writeState({
          ...state,
          [threadId]: {
            sessionId: parsed.sessionId,
            syncedMessageCount: parsed.messages.length,
            tailImported: nextTailImported,
            ...(named.pendingName !== undefined ? { pendingName: named.pendingName } : {}),
          },
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("PrimeAgent session sync state write failed.", { cause }),
          ),
        );
      }
      return importedCount;
    });

  const syncThread = (threadId: ThreadId) =>
    semaphore
      .withPermits(1)(syncThreadLocked(threadId))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("PrimeAgent session sync failed.", { cause }).pipe(Effect.as(0)),
        ),
      );

  const noteTurnCompleted = (threadId: ThreadId) =>
    semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const sessionFile = yield* findThreadSessionFile(threadId);
          if (!sessionFile) {
            return;
          }
          const parsed = yield* parseSessionAt(sessionFile);
          if (!parsed) {
            return;
          }
          const state = yield* readState;
          const named = yield* flushPendingName(sessionFile, parsed, state[threadId]);
          yield* writeState({
            ...state,
            [threadId]: {
              sessionId: parsed.sessionId,
              syncedMessageCount: parsed.messages.length,
              // The tail is this turn's own output, rendered natively.
              tailImported: false,
              ...(named.pendingName !== undefined ? { pendingName: named.pendingName } : {}),
            },
          });
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("PrimeAgent session sync cursor update failed.", { cause }),
        ),
      );

  const noteTitleChanged = (threadId: ThreadId, title: string) =>
    semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const sessionFile = yield* findThreadSessionFile(threadId);
          if (!sessionFile) {
            return;
          }
          const parsed = yield* parseSessionAt(sessionFile);
          if (!parsed) {
            return;
          }
          const name = title.trim();
          if (name.length === 0 || (parsed.name !== null && toThreadTitle(parsed.name) === name)) {
            return;
          }
          const state = yield* readState;
          const recorded: ThreadSyncState = state[threadId] ?? {
            sessionId: parsed.sessionId,
            syncedMessageCount: parsed.messages.length,
            tailImported: false,
          };
          if (!hasAssistantMessage(parsed)) {
            yield* writeState({ ...state, [threadId]: { ...recorded, pendingName: name } });
            return;
          }
          yield* appendSessionName(sessionFile, parsed, name);
          if (recorded.pendingName !== undefined) {
            const { pendingName: _flushed, ...rest } = recorded;
            yield* writeState({ ...state, [threadId]: rest });
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("PrimeAgent session name write failed.", { cause, threadId }),
        ),
      );

  const removeQuietly = (target: string) =>
    fileSystem.remove(target, { recursive: true, force: true }).pipe(Effect.ignoreCause({ log: true }));

  /** prime-agent keeps a session's artifacts at `<sessionDir>/../session-artifacts/<sessionId>`. */
  const artifactsDirFor = (sessionFile: string) =>
    path.join(
      path.dirname(sessionFile),
      "..",
      "session-artifacts",
      path.basename(sessionFile, ".jsonl"),
    );

  const forgetThread = (threadId: ThreadId) =>
    semaphore
      .withPermits(1)(
        Effect.gen(function* () {
          const threadDir = path.join(threadsRoot, threadId);
          const entries = yield* fileSystem
            .readDirectory(threadDir)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          for (const entry of entries) {
            if (!entry.endsWith(".jsonl")) {
              continue;
            }
            const linkPath = path.join(threadDir, entry);
            // A symlink means the thread lived on the agent's own file: that
            // file goes too. A plain file is a private copy; the TUI's
            // original (if any) is not ours to delete.
            const linkTarget = yield* fileSystem.readLink(linkPath).pipe(
              Effect.map((target): string | undefined => target),
              Effect.orElseSucceed(() => undefined),
            );
            const sessionFile =
              linkTarget === undefined ? linkPath : path.resolve(threadDir, linkTarget);
            yield* Effect.logInfo("PrimeAgent session removed with its thread.", {
              threadId,
              sessionFile,
            });
            yield* removeQuietly(sessionFile);
            yield* removeQuietly(artifactsDirFor(sessionFile));
          }
          yield* removeQuietly(threadDir);

          const state = yield* readState;
          if (state[threadId] !== undefined) {
            const { [threadId]: _forgotten, ...rest } = state;
            yield* writeState(rest);
          }
          const registry = yield* readJsonObject(registryPath);
          const kept = Object.fromEntries(
            Object.entries(registry).filter(
              ([, value]) => !(isRecord(value) && value.threadId === threadId),
            ),
          );
          if (Object.keys(kept).length !== Object.keys(registry).length) {
            yield* writeJsonObject(registryPath, kept);
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("PrimeAgent session removal failed.", { cause, threadId }),
        ),
      );

  /** Threads with a session file, discovered from the per-thread link dirs. */
  const listLinkedThreads = Effect.gen(function* () {
    const entries = yield* fileSystem
      .readDirectory(threadsRoot)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    return entries.map((entry) => ThreadId.make(entry));
  });

  const syncIdleLinkedThreads = Effect.gen(function* () {
    const threadIds = yield* listLinkedThreads;
    for (const threadId of threadIds) {
      const active = yield* isThreadTurnActive(threadId);
      if (active) {
        continue;
      }
      yield* syncThread(threadId);
    }
  });

  // TUI activity lands in the shared session dir; watch it so an open thread
  // catches up without waiting for its next turn. Debounced because one
  // agent turn writes many entries in quick succession.
  const sharedSessionDir = resolvePrimeAgentSharedSessionDir(process.env, path);
  yield* fileSystem
    .makeDirectory(sharedSessionDir, { recursive: true })
    .pipe(Effect.ignoreCause({ log: true }));
  yield* Stream.runForEach(
    fileSystem.watch(sharedSessionDir).pipe(Stream.debounce(Duration.millis(500))),
    () => syncIdleLinkedThreads.pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  // T3 title changes (generated or manual) go into the file. Forked per
  // event: the write takes the sync permit, and a sync in progress may be
  // the one dispatching the title update that produced this event.
  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    event.type === "thread.meta-updated" && event.payload.title !== undefined
      ? Effect.forkChild(noteTitleChanged(event.payload.threadId, event.payload.title)).pipe(
          Effect.asVoid,
        )
      : Effect.void,
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  return PrimeAgentSessionSync.of({
    syncThread,
    noteTurnCompleted,
    noteTitleChanged,
    forgetThread,
  });
});

export const layer = Layer.effect(PrimeAgentSessionSync, make);
