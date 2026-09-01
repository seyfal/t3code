import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import { ServerConfig } from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PrimeAgentSessionSync, make as makeSessionSync } from "./PrimeAgentSessionSync.ts";

const threadId = ThreadId.make("thread-sync-1");

function sessionLine(entry: unknown): string {
  return `${JSON.stringify(entry)}\n`;
}

function userMessage(text: string, timestamp: string): string {
  return sessionLine({
    type: "message",
    timestamp,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

describe("PrimeAgentSessionSync", () => {
  let baseDir: string;
  let sessionFile: string;
  let dispatched: Array<{ type: string; messages?: ReadonlyArray<{ messageId: string }> }>;
  let runtime: ManagedRuntime.ManagedRuntime<PrimeAgentSessionSync, unknown>;
  let threadMessages: Array<{ id: string }>;

  beforeAll(() => {
    baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prime-sync-test-"));
    // ServerConfig.layerTest derives stateDir as `<baseDir>/userdata`.
    const stateDir = NodePath.join(baseDir, "userdata");
    const sharedDir = NodePath.join(baseDir, "shared-sessions");
    const threadDir = NodePath.join(stateDir, "prime-agent-sessions", threadId);
    NodeFS.mkdirSync(sharedDir, { recursive: true });
    NodeFS.mkdirSync(threadDir, { recursive: true });
    sessionFile = NodePath.join(sharedDir, "sess-sync.jsonl");
    NodeFS.writeFileSync(
      sessionFile,
      sessionLine({
        type: "session",
        id: "sess-sync",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/sync-project",
      }) + userMessage("first from tui", "2026-01-01T00:00:01.000Z"),
    );
    NodeFS.symlinkSync(sessionFile, NodePath.join(threadDir, "sess-sync.jsonl"));
    // The watcher resolves the shared dir from the environment.
    process.env["PRIME_AGENT_SESSION_DIR"] = sharedDir;

    dispatched = [];
    threadMessages = [];
    const engineStub = Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
      dispatch: (command: { type: string }) => {
        dispatched.push(command as (typeof dispatched)[number]);
        return Effect.succeed({ sequence: dispatched.length });
      },
    } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]);
    const projectionStub = Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getCommandReadModel: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [],
          threads: [
            {
              id: threadId,
              messages: [],
              session: null,
            },
            {
              id: "thread-sync-imported",
              messages: threadMessages,
              session: null,
            },
          ],
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);
    const layer = Layer.effect(PrimeAgentSessionSync, makeSessionSync).pipe(
      Layer.provide(engineStub),
      Layer.provide(projectionStub),
      Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
  });

  afterAll(async () => {
    delete process.env["PRIME_AGENT_SESSION_DIR"];
    await runtime.dispose();
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("baselines a native thread without importing, then imports foreign entries", async () => {
    const sync = await runtime.runPromise(Effect.service(PrimeAgentSessionSync));

    // First contact: no prime-import ids in the thread, so the existing file
    // content counts as already-rendered native history - nothing imports.
    const first = await runtime.runPromise(sync.syncThread(threadId));
    expect(first).toBe(0);
    expect(dispatched).toHaveLength(0);

    // The TUI appends two entries; only those import, with deterministic ids.
    NodeFS.appendFileSync(
      sessionFile,
      userMessage("second from tui", "2026-01-01T00:01:00.000Z") +
        userMessage("third from tui", "2026-01-01T00:02:00.000Z"),
    );
    const second = await runtime.runPromise(sync.syncThread(threadId));
    expect(second).toBe(2);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.messages?.map((message) => message.messageId)).toEqual([
      "prime-import:sess-sync:1",
      "prime-import:sess-sync:2",
    ]);

    // Re-running with nothing new re-sends at most the healing tail message,
    // never fresh content.
    const third = await runtime.runPromise(sync.syncThread(threadId));
    expect(third).toBe(0);

    // After a T3 turn appended an entry, the cursor advances without import.
    NodeFS.appendFileSync(sessionFile, userMessage("from t3 turn", "2026-01-01T00:03:00.000Z"));
    await runtime.runPromise(sync.noteTurnCompleted(threadId));
    const afterTurn = await runtime.runPromise(sync.syncThread(threadId));
    expect(afterTurn).toBe(0);
  });

  it("resumes an imported thread after its highest imported index", async () => {
    const importedThreadId = ThreadId.make("thread-sync-imported");
    const threadDir = NodePath.join(baseDir, "userdata", "prime-agent-sessions", importedThreadId);
    NodeFS.mkdirSync(threadDir, { recursive: true });
    const importedFile = NodePath.join(baseDir, "shared-sessions", "sess-imported.jsonl");
    NodeFS.writeFileSync(
      importedFile,
      sessionLine({
        type: "session",
        id: "sess-imported",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/sync-project",
      }) +
        userMessage("imported one", "2026-01-01T00:00:01.000Z") +
        userMessage("appended later", "2026-01-01T00:05:00.000Z"),
    );
    NodeFS.symlinkSync(importedFile, NodePath.join(threadDir, "sess-imported.jsonl"));
    // The initial import backfilled index 0; the read model shows its id.
    threadMessages.push({ id: "prime-import:sess-imported:0" });
    const sync = await runtime.runPromise(Effect.service(PrimeAgentSessionSync));

    dispatched.length = 0;
    const imported = await runtime.runPromise(sync.syncThread(importedThreadId));
    // Cursor initializes to highest imported index + 1 = 1: only the later
    // appended entry (index 1) imports, and index 0 re-sends as the healing
    // upsert of the last known message.
    expect(imported).toBe(1);
    const ids = dispatched.flatMap(
      (command) => command.messages?.map((message) => message.messageId) ?? [],
    );
    expect(ids).toContain("prime-import:sess-imported:1");
  });
});
