import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
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

function assistantMessage(text: string, timestamp: string): string {
  return sessionLine({
    type: "message",
    id: `a-${timestamp}`,
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
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
  let dispatched: Array<{
    type: string;
    title?: string;
    messages?: ReadonlyArray<{ messageId: string }>;
  }>;
  let namedTitle = "New thread";
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
      streamDomainEvents: Stream.never,
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
            {
              id: "thread-sync-named",
              title: namedTitle,
              messages: [],
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

  it("mirrors the session name into the thread title and a T3 title back into the file", async () => {
    const namedThreadId = ThreadId.make("thread-sync-named");
    const threadDir = NodePath.join(baseDir, "userdata", "prime-agent-sessions", namedThreadId);
    NodeFS.mkdirSync(threadDir, { recursive: true });
    const namedFile = NodePath.join(baseDir, "shared-sessions", "sess-named.jsonl");
    NodeFS.writeFileSync(
      namedFile,
      sessionLine({
        type: "session",
        id: "sess-named",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/sync-project",
      }) +
        userMessage("hello", "2026-01-01T00:00:01.000Z") +
        assistantMessage("hi", "2026-01-01T00:00:02.000Z") +
        sessionLine({
          type: "session_info",
          id: "info-1",
          parentId: "a-2026-01-01T00:00:02.000Z",
          timestamp: "2026-01-01T00:00:03.000Z",
          name: "Named in TUI",
        }),
    );
    NodeFS.symlinkSync(namedFile, NodePath.join(threadDir, "sess-named.jsonl"));
    const sync = await runtime.runPromise(Effect.service(PrimeAgentSessionSync));

    // File name -> thread title.
    dispatched.length = 0;
    await runtime.runPromise(sync.syncThread(namedThreadId));
    expect(dispatched.filter((command) => command.type === "thread.meta.update")).toEqual([
      expect.objectContaining({ title: "Named in TUI" }),
    ]);

    // T3 title -> file, as a session_info entry parented to the last entry.
    namedTitle = "Named in TUI";
    await runtime.runPromise(sync.noteTitleChanged(namedThreadId, "Renamed in T3"));
    const lines = NodeFS.readFileSync(namedFile, "utf8").trim().split("\n");
    const appended = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
    expect(appended).toMatchObject({
      type: "session_info",
      parentId: "info-1",
      name: "Renamed in T3",
    });

    // The same title again is not written twice; a sync does not bounce it.
    namedTitle = "Renamed in T3";
    dispatched.length = 0;
    await runtime.runPromise(sync.noteTitleChanged(namedThreadId, "Renamed in T3"));
    await runtime.runPromise(sync.syncThread(namedThreadId));
    expect(NodeFS.readFileSync(namedFile, "utf8").trim().split("\n")).toHaveLength(lines.length);
    expect(dispatched.filter((command) => command.type === "thread.meta.update")).toHaveLength(0);
  });

  it("holds a title until the file has an assistant message, then writes it", async () => {
    const pendingThreadId = ThreadId.make("thread-sync-pending");
    const threadDir = NodePath.join(baseDir, "userdata", "prime-agent-sessions", pendingThreadId);
    NodeFS.mkdirSync(threadDir, { recursive: true });
    const pendingFile = NodePath.join(baseDir, "shared-sessions", "sess-pending.jsonl");
    NodeFS.writeFileSync(
      pendingFile,
      sessionLine({
        type: "session",
        id: "sess-pending",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/sync-project",
      }) + userMessage("first question", "2026-01-01T00:00:01.000Z"),
    );
    NodeFS.symlinkSync(pendingFile, NodePath.join(threadDir, "sess-pending.jsonl"));
    const sync = await runtime.runPromise(Effect.service(PrimeAgentSessionSync));

    await runtime.runPromise(sync.noteTitleChanged(pendingThreadId, "Generated Title"));
    expect(NodeFS.readFileSync(pendingFile, "utf8")).not.toContain("session_info");

    NodeFS.appendFileSync(pendingFile, assistantMessage("answer", "2026-01-01T00:00:02.000Z"));
    await runtime.runPromise(sync.noteTurnCompleted(pendingThreadId));
    const lines = NodeFS.readFileSync(pendingFile, "utf8").trim().split("\n");
    expect(JSON.parse(lines[lines.length - 1] ?? "{}")).toMatchObject({
      type: "session_info",
      parentId: "a-2026-01-01T00:00:02.000Z",
      name: "Generated Title",
    });
    const state = JSON.parse(
      NodeFS.readFileSync(NodePath.join(baseDir, "userdata", "prime-agent-sync.json"), "utf8"),
    ) as Record<string, { pendingName?: string }>;
    expect(state[pendingThreadId]?.pendingName).toBeUndefined();
  });

  it("forgetThread removes a linked session file, a private copy only for itself", async () => {
    const sync = await runtime.runPromise(Effect.service(PrimeAgentSessionSync));
    const stateDir = NodePath.join(baseDir, "userdata");

    // Linked thread: the shared file, its artifacts and the link dir go.
    const linkedThreadId = ThreadId.make("thread-sync-named");
    const linkedFile = NodePath.join(baseDir, "shared-sessions", "sess-named.jsonl");
    const artifacts = NodePath.join(baseDir, "session-artifacts", "sess-named");
    NodeFS.mkdirSync(artifacts, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "prime-agent-imports.json"),
      JSON.stringify({
        "sess-named": { threadId: linkedThreadId, importedAt: "2026-01-01T00:00:00.000Z" },
        "sess-other": { threadId: "someone-else", importedAt: "2026-01-01T00:00:00.000Z" },
      }),
    );
    await runtime.runPromise(sync.forgetThread(linkedThreadId));
    expect(NodeFS.existsSync(linkedFile)).toBe(false);
    expect(NodeFS.existsSync(artifacts)).toBe(false);
    expect(
      NodeFS.existsSync(NodePath.join(stateDir, "prime-agent-sessions", linkedThreadId)),
    ).toBe(false);
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(stateDir, "prime-agent-imports.json"), "utf8")),
    ).toEqual({
      "sess-other": { threadId: "someone-else", importedAt: "2026-01-01T00:00:00.000Z" },
    });

    // Copy thread: only the copy goes; the original in the shared dir stays.
    const copyThreadId = ThreadId.make("thread-sync-copy");
    const copyDir = NodePath.join(stateDir, "prime-agent-sessions", copyThreadId);
    NodeFS.mkdirSync(copyDir, { recursive: true });
    const original = NodePath.join(baseDir, "shared-sessions", "sess-sync.jsonl");
    NodeFS.copyFileSync(original, NodePath.join(copyDir, "sess-sync.jsonl"));
    await runtime.runPromise(sync.forgetThread(copyThreadId));
    expect(NodeFS.existsSync(copyDir)).toBe(false);
    expect(NodeFS.existsSync(original)).toBe(true);
  });
});
