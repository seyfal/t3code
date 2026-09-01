import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  applyPrimeAgentAcpModelSelection,
  buildPrimeAgentAcpSpawnInput,
  currentPrimeAgentModelIdFromSessionSetup,
  currentPrimeAgentReasoningEffortFromSessionSetup,
  primeAgentAcpSpawnArgs,
  resolvePrimeAgentAcpBaseModelId,
} from "./PrimeAgentAcpSupport.ts";

describe("primeAgentAcpSpawnArgs", () => {
  it("always speaks ACP and rides model + session continuity on argv", () => {
    expect(primeAgentAcpSpawnArgs()).toEqual(["--mode", "acp"]);
    expect(primeAgentAcpSpawnArgs({ modelId: "sonnet" })).toEqual([
      "--mode",
      "acp",
      "--model",
      "sonnet",
    ]);
    // Resume never uses `--resume <acpSessionId>`: prime-agent's ACP
    // session id is a fresh random UUID unrelated to the saved session
    // file. Continuity is a per-thread `--session-dir` plus `--continue`.
    expect(primeAgentAcpSpawnArgs({ sessionDir: "/state/prime-agent-sessions/thread-1" })).toEqual([
      "--mode",
      "acp",
      "--session-dir",
      "/state/prime-agent-sessions/thread-1",
    ]);
    expect(
      primeAgentAcpSpawnArgs({
        modelId: "sonnet",
        thinkingLevel: "high",
        approval: true,
        sessionDir: "/state/prime-agent-sessions/thread-1",
        continueConversation: true,
      }),
    ).toEqual([
      "--mode",
      "acp",
      "--model",
      "sonnet",
      "--thinking",
      "high",
      "--approval",
      "--session-dir",
      "/state/prime-agent-sessions/thread-1",
      "--continue",
    ]);
  });
});

describe("buildPrimeAgentAcpSpawnInput", () => {
  it("defaults the command to prime-agent and honors binaryPath", () => {
    const spawnInput = buildPrimeAgentAcpSpawnInput(null, "/tmp/project");
    expect(spawnInput.command).toBe("prime-agent");
    expect(spawnInput.args).toEqual(["--mode", "acp"]);
    expect(spawnInput.cwd).toBe("/tmp/project");

    const custom = buildPrimeAgentAcpSpawnInput(
      { binaryPath: "/opt/bin/prime-agent" },
      "/tmp/project",
      { HOME: "/home/user" },
      { modelId: "sonnet" },
    );
    expect(custom.command).toBe("/opt/bin/prime-agent");
    expect(custom.args).toEqual(["--mode", "acp", "--model", "sonnet"]);
    expect(custom.env?.HOME).toBe("/home/user");
  });
});

describe("resolvePrimeAgentAcpBaseModelId", () => {
  it("falls back to the sonnet pattern for empty ids", () => {
    expect(resolvePrimeAgentAcpBaseModelId(undefined)).toBe("sonnet");
    expect(resolvePrimeAgentAcpBaseModelId("   ")).toBe("sonnet");
    expect(resolvePrimeAgentAcpBaseModelId("  openai/gpt-5.1-codex  ")).toBe(
      "openai/gpt-5.1-codex",
    );
  });
});

function modelConfigOption(
  currentValue: string,
  values: ReadonlyArray<string>,
): EffectAcpSchema.SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  } as EffectAcpSchema.SessionConfigOption;
}

function thinkingConfigOption(currentValue: string): EffectAcpSchema.SessionConfigOption {
  return {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue,
    options: ["off", "low", "medium", "high"].map((value) => ({ value, name: value })),
  } as EffectAcpSchema.SessionConfigOption;
}

function selectionRuntime(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  afterModelSwitch?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
) {
  const setCalls: Array<{ configId: string; value: string | boolean }> = [];
  let current = configOptions;
  const runtime = {
    getConfigOptions: Effect.suspend(() => Effect.succeed(current)),
    setConfigOption: (configId: string, value: string | boolean) =>
      Effect.sync(() => {
        setCalls.push({ configId, value });
        if (configId === "model" && afterModelSwitch) {
          current = afterModelSwitch;
        }
        return { configOptions: current } as EffectAcpSchema.SetSessionConfigOptionResponse;
      }),
  } satisfies Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  return { runtime, setCalls };
}

describe("applyPrimeAgentAcpModelSelection", () => {
  it.effect("switches model and thinking through advertised config options", () =>
    Effect.gen(function* () {
      const { runtime, setCalls } = selectionRuntime([
        modelConfigOption("a/model-one", ["a/model-one", "b/sub/model-two"]),
        thinkingConfigOption("medium"),
      ]);

      const bound = yield* applyPrimeAgentAcpModelSelection({
        runtime,
        currentModelId: "a/model-one",
        currentReasoningEffort: "medium",
        requestedModelId: "b/sub/model-two",
        requestedReasoningEffort: "high",
        mapError: (cause) => cause,
      });
      expect(bound).toBe("b/sub/model-two");
      expect(setCalls).toEqual([
        { configId: "model", value: "b/sub/model-two" },
        { configId: "thinking", value: "high" },
      ]);
    }),
  );

  it.effect("skips values outside the advertised catalog instead of failing the turn", () =>
    Effect.gen(function* () {
      const { runtime, setCalls } = selectionRuntime([
        modelConfigOption("a/model-one", ["a/model-one"]),
        thinkingConfigOption("medium"),
      ]);

      const bound = yield* applyPrimeAgentAcpModelSelection({
        runtime,
        currentModelId: "a/model-one",
        requestedModelId: "not/in-catalog",
        requestedReasoningEffort: "xhigh",
        mapError: (cause) => cause,
      });
      expect(bound).toBe("a/model-one");
      expect(setCalls).toEqual([]);
    }),
  );

  it.effect("validates thinking against the catalog the new model reports", () =>
    Effect.gen(function* () {
      // The old model supports "medium"; the new one does not. The thinking
      // write must be validated against the post-switch catalog, and a level
      // the new model lacks is skipped instead of failing the turn.
      const { runtime, setCalls } = selectionRuntime(
        [
          modelConfigOption("a/model-one", ["a/model-one", "b/model-two"]),
          thinkingConfigOption("medium"),
        ],
        [
          modelConfigOption("b/model-two", ["a/model-one", "b/model-two"]),
          {
            id: "thinking",
            name: "Thinking",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              { value: "off", name: "off" },
              { value: "high", name: "high" },
            ],
          } as EffectAcpSchema.SessionConfigOption,
        ],
      );

      const bound = yield* applyPrimeAgentAcpModelSelection({
        runtime,
        currentModelId: "a/model-one",
        requestedModelId: "b/model-two",
        requestedReasoningEffort: "medium",
        mapError: (cause) => cause,
      });
      expect(bound).toBe("b/model-two");
      expect(setCalls).toEqual([{ configId: "model", value: "b/model-two" }]);
    }),
  );

  it.effect("keeps the spawn-time model on a binary without config options", () =>
    Effect.gen(function* () {
      const { runtime, setCalls } = selectionRuntime([]);

      const sessionWins = yield* applyPrimeAgentAcpModelSelection({
        runtime,
        currentModelId: "session-reported",
        requestedModelId: "requested",
        mapError: (cause) => cause,
      });
      expect(sessionWins).toBe("session-reported");

      const requestedFallback = yield* applyPrimeAgentAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "requested",
        mapError: (cause) => cause,
      });
      expect(requestedFallback).toBe("requested");
      expect(setCalls).toEqual([]);
    }),
  );
});

describe("session setup readers", () => {
  it("reads the current model and thinking level from config options", () => {
    const setup = {
      sessionId: "s1",
      configOptions: [
        modelConfigOption("a/model-one", ["a/model-one"]),
        thinkingConfigOption("high"),
      ],
    } as unknown as EffectAcpSchema.NewSessionResponse;
    expect(currentPrimeAgentModelIdFromSessionSetup(setup)).toBe("a/model-one");
    expect(currentPrimeAgentReasoningEffortFromSessionSetup(setup)).toBe("high");

    const bare = { sessionId: "s2" } as unknown as EffectAcpSchema.NewSessionResponse;
    expect(currentPrimeAgentModelIdFromSessionSetup(bare)).toBeUndefined();
    expect(currentPrimeAgentReasoningEffortFromSessionSetup(bare)).toBeUndefined();
  });
});
