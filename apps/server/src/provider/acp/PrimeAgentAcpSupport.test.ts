import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  applyPrimeAgentAcpModelSelection,
  buildPrimeAgentAcpSpawnInput,
  primeAgentAcpSpawnArgs,
  resolvePrimeAgentAcpBaseModelId,
} from "./PrimeAgentAcpSupport.ts";

describe("primeAgentAcpSpawnArgs", () => {
  it("always speaks ACP and rides model + resume on argv", () => {
    expect(primeAgentAcpSpawnArgs()).toEqual(["--mode", "acp"]);
    expect(primeAgentAcpSpawnArgs({ modelId: "sonnet" })).toEqual([
      "--mode",
      "acp",
      "--model",
      "sonnet",
    ]);
    expect(primeAgentAcpSpawnArgs({ resumeSessionId: "abc-123" })).toEqual([
      "--mode",
      "acp",
      "--resume",
      "abc-123",
    ]);
    expect(primeAgentAcpSpawnArgs({ modelId: "sonnet", resumeSessionId: "abc-123" })).toEqual([
      "--mode",
      "acp",
      "--model",
      "sonnet",
      "--resume",
      "abc-123",
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
    expect(resolvePrimeAgentAcpBaseModelId("  openai/gpt-5.1-codex  ")).toBe("openai/gpt-5.1-codex");
  });
});

describe("applyPrimeAgentAcpModelSelection", () => {
  it("never calls session/set_model and reports the effective model", async () => {
    let setSessionModelCalls = 0;
    const runtime = {
      setSessionModel: () =>
        Effect.sync(() => {
          setSessionModelCalls += 1;
        }),
    };

    const sessionWins = await Effect.runPromise(
      applyPrimeAgentAcpModelSelection({
        runtime,
        currentModelId: "session-reported",
        requestedModelId: "requested",
        mapError: (cause) => cause,
      }),
    );
    expect(sessionWins).toBe("session-reported");

    const requestedFallback = await Effect.runPromise(
      applyPrimeAgentAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "requested",
        mapError: (cause) => cause,
      }),
    );
    expect(requestedFallback).toBe("requested");
    expect(setSessionModelCalls).toBe(0);
  });
});
