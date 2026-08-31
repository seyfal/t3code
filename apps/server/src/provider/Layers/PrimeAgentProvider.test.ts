import { describe, expect, it } from "@effect/vitest";

import { parsePrimeAgentModelListOutput } from "./PrimeAgentProvider.ts";

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
