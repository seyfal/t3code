import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-import");
const threadId = ThreadId.make("thread-import");

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: EventId.make("evt-project-create"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-project-create"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-create"),
    metadata: {},
    payload: {
      projectId,
      title: "Import Project",
      workspaceRoot: "/tmp/import-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-thread-create"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Imported session",
      modelSelection: {
        instanceId: ProviderInstanceId.make("primeAgent"),
        model: "baseten/moonshotai/Kimi-K3",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("thread.transcript.import", (it) => {
  it.effect("emits one message-sent per message with source timestamps", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.transcript.import",
          commandId: CommandId.make("cmd-transcript-import"),
          threadId,
          messages: [
            {
              messageId: MessageId.make("prime-import:s1:0"),
              role: "user",
              text: "hello from the TUI",
              createdAt: "2025-12-01T10:00:00.000Z",
            },
            {
              messageId: MessageId.make("prime-import:s1:1"),
              role: "assistant",
              text: "hello back",
              createdAt: "2025-12-01T10:00:05.000Z",
            },
          ],
          createdAt: now,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(2);
      expect(
        events.map((event) => (event.type === "thread.message-sent" ? event.payload : null)),
      ).toEqual([
        expect.objectContaining({
          threadId,
          role: "user",
          text: "hello from the TUI",
          turnId: null,
          streaming: false,
          createdAt: "2025-12-01T10:00:00.000Z",
        }),
        expect.objectContaining({
          threadId,
          role: "assistant",
          text: "hello back",
          createdAt: "2025-12-01T10:00:05.000Z",
        }),
      ]);
    }),
  );

  it.effect("refuses an unknown thread", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.transcript.import",
            commandId: CommandId.make("cmd-transcript-import-missing"),
            threadId: ThreadId.make("thread-missing"),
            messages: [
              {
                messageId: MessageId.make("prime-import:s2:0"),
                role: "user",
                text: "orphan",
                createdAt: now,
              },
            ],
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(String(error.message ?? error)).toContain("thread-missing");
    }),
  );
});
