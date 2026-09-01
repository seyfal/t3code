import { describe, expect, it } from "@effect/vitest";

import {
  parsePrimeAgentModelListOutput,
  primeAgentVersionSupportsAcp,
} from "./PrimeAgentProvider.ts";

describe("primeAgentVersionSupportsAcp", () => {
  it("gates on the 0.8.0 ACP floor and lets unknown schemes through", () => {
    expect(primeAgentVersionSupportsAcp("0.8.1")).toBe(true);
    expect(primeAgentVersionSupportsAcp("1.0.0")).toBe(true);
    expect(primeAgentVersionSupportsAcp("0.7.2")).toBe(false);
    // The npm-published pi lineage reports 0.84.x — and 84 >= 8, which is
    // correct only by accident of the shared version scheme; the real gate
    // for that package is its missing `--mode acp`, caught at spawn.
    expect(primeAgentVersionSupportsAcp("nonsense")).toBe(true);
  });
});

describe("parsePrimeAgentModelListOutput", () => {
  it("parses the padded table into provider/id slugs", () => {
    const output = [
      "provider   model              context  max-out  thinking  images",
      "anthropic  claude-sonnet-4-5  200K     64K      yes       yes",
      "openai     gpt-5.1-codex      400K     128K     yes       no",
      "",
    ].join("\n");
    expect(parsePrimeAgentModelListOutput(output).map((model) => model.slug)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.1-codex",
    ]);
  });

  it("returns [] for the logged-out message and unrecognized output", () => {
    expect(
      parsePrimeAgentModelListOutput("No models available. Use /login to log into a provider."),
    ).toEqual([]);
    expect(parsePrimeAgentModelListOutput("")).toEqual([]);
  });
});
