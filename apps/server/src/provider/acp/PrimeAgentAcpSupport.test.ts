import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  applyPrimeAgentAcpModelSelection,
  buildPrimeAgentAcpSpawnInput,
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
        sessionDir: "/state/prime-agent-sessions/thread-1",
        continueConversation: true,
      }),
    ).toEqual([
      "--mode",
      "acp",
      "--model",
      "sonnet",
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

describe("applyPrimeAgentAcpModelSelection", () => {
  it.effect("never calls session/set_model and reports the effective model", () =>
    Effect.gen(function* () {
      let setSessionModelCalls = 0;
      const runtime = {
        setSessionModel: (_modelId: string) =>
          Effect.sync(() => {
            setSessionModelCalls += 1;
            return {} as EffectAcpSchema.SetSessionModelResponse;
          }),
      } satisfies Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;

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
      expect(setSessionModelCalls).toBe(0);
    }),
  );
});
