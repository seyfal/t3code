// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  PrimeAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makePrimeAgentAdapter } from "./PrimeAgentAdapter.ts";

const decodePrimeAgentSettings = Schema.decodeSync(PrimeAgentSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockPrimeAgentWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-prime-agent.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const primeAgentAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-prime-agent-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (
  binaryPath: string,
  options?: Parameters<typeof makePrimeAgentAdapter>[1],
) => makePrimeAgentAdapter(decodePrimeAgentSettings({ binaryPath }), options).pipe(Effect.orDie);

it.layer(primeAgentAdapterTestLayer)("PrimeAgentAdapterLive", (it) => {
  it.effect("completes a prompt flow without ever calling authenticate", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("prime-agent-mock-thread");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-agent-request-log-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.log");

      // Prime Agent's ACP surface has no `authenticate` method: the mock is
      // told to fail that call with method-not-found so the test breaks
      // loudly if the runtime ever reintroduces the unconditional call.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockPrimeAgentWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_REJECT_AUTHENTICATE: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("primeAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("primeAgent"),
          model: "sonnet",
        },
      });

      assert.equal(session.provider, "primeAgent");
      // The mock's session/new reports a current model; with no
      // session/set_model available, the session-reported model wins over
      // the requested one (which is pinned via `--model` on argv instead).
      assert.isDefined(session.model);
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello prime agent",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);

      const loggedRequests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const loggedMethods = loggedRequests.map((entry) => entry.method);
      assert.include(loggedMethods, "initialize");
      assert.include(loggedMethods, "session/new");
      assert.notInclude(loggedMethods, "authenticate");
      assert.notInclude(loggedMethods, "session/load");
    }),
  );
});
