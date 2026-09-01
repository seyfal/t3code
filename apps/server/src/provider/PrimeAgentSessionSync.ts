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
 * Trigger points:
 * - before every T3 turn (write safety: sync first, then prompt),
 * - after every T3 turn (advance the cursor past our own turn's entries
 *   without re-importing them - they already rendered natively),
 * - a watcher on the shared session directory (TUI activity shows up in the
 *   open thread without waiting for the next turn).
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
} from "./PrimeAgentSessionImport.ts";

const SYNC_STATE_FILE = "prime-agent-sync.json";
const SYNC_CHUNK_SIZE = 200;
const MESSAGE_ID_PREFIX = "prime-import";

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
     * Backfills unseen session-file entries into the thread. No-ops for
     * threads without a prime-agent session file. Called before every turn
     * (write safety: the turn proceeds only after T3 has caught up) and by
     * the shared-directory watcher.
     */
    readonly syncThread: (threadId: ThreadId) => Effect.Effect<number>;
    /**
     * Advances the cursor to the current end of the file without importing:
     * the entries a T3 turn just appended are already rendered natively.
     */
    readonly noteTurnCompleted: (threadId: ThreadId) => Effect.Effect<void>;
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

  const readState = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(statePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) {
      return {} as SyncStateFile;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? (parsed as SyncStateFile) : ({} as SyncStateFile);
    } catch {
      return {} as SyncStateFile;
    }
  });

  const writeState = (state: SyncStateFile) =>
    fileSystem.writeFileString(statePath, `${JSON.stringify(state, null, 2)}\n`);

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

  /**
   * Where the cursor starts for a thread that has no recorded state.
   * Imported threads resume after their highest imported index; native
   * threads start at the current end of file (their history already rendered
   * as native turn messages - re-importing it would duplicate every row).
   */
  const initialCursor = (threadId: ThreadId, sessionId: string, messageCount: number) =>
    Effect.gen(function* () {
      const readModel = yield* projectionSnapshotQuery
        .getCommandReadModel()
        .pipe(Effect.orElseSucceed(() => undefined));
      const thread = readModel?.threads.find((entry) => entry.id === threadId);
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
    });

  const isThreadTurnActive = (threadId: ThreadId) =>
    projectionSnapshotQuery.getCommandReadModel().pipe(
      Effect.map((readModel) => {
        const session = readModel.threads.find((entry) => entry.id === threadId)?.session;
        return session?.status === "running" || session?.activeTurnId != null;
      }),
      Effect.orElseSucceed(() => false),
    );

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
      const state = yield* readState;
      const recorded = state[threadId];
      const resumed =
        recorded && recorded.sessionId === parsed.sessionId
          ? { cursor: recorded.syncedMessageCount, tailImported: recorded.tailImported === true }
          : yield* initialCursor(threadId, parsed.sessionId, parsed.messages.length);
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
      const nextTailImported = importedCount > 0 ? true : resumed.tailImported;
      if (
        !recorded ||
        recorded.sessionId !== parsed.sessionId ||
        recorded.syncedMessageCount !== parsed.messages.length ||
        recorded.tailImported !== nextTailImported
      ) {
        yield* writeState({
          ...state,
          [threadId]: {
            sessionId: parsed.sessionId,
            syncedMessageCount: parsed.messages.length,
            tailImported: nextTailImported,
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
          yield* writeState({
            ...state,
            [threadId]: {
              sessionId: parsed.sessionId,
              syncedMessageCount: parsed.messages.length,
              // The tail is this turn's own output, rendered natively.
              tailImported: false,
            },
          });
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("PrimeAgent session sync cursor update failed.", { cause }),
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

  return PrimeAgentSessionSync.of({ syncThread, noteTurnCompleted });
});

export const layer = Layer.effect(PrimeAgentSessionSync, make);
