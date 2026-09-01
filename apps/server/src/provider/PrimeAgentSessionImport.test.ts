import { describe, expect, it } from "@effect/vitest";

import { parsePrimeAgentSessionFile } from "./PrimeAgentSessionImport.ts";

function line(entry: unknown): string {
  return JSON.stringify(entry);
}

const header = line({
  type: "session",
  version: 3,
  id: "sess-1",
  timestamp: "2025-12-01T10:00:00.000Z",
  cwd: "/home/ubuntu/project",
});

describe("parsePrimeAgentSessionFile", () => {
  it("extracts messages, name, and the last model", () => {
    const raw = [
      header,
      line({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2025-12-01T10:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      }),
      line({ type: "session_info", id: "i1", parentId: "m1", timestamp: "", name: "My session" }),
      line({
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2025-12-01T10:00:05.000Z",
        message: {
          role: "assistant",
          provider: "baseten",
          model: "moonshotai/Kimi-K3",
          stopReason: "end_turn",
          content: [
            { type: "thinking", thinking: "pondering" },
            { type: "text", text: "hi there" },
            { type: "toolCall", id: "t1", name: "ipython" },
          ],
        },
      }),
      // Tool-only and errored assistant turns carry nothing to backfill.
      line({
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: "2025-12-01T10:00:06.000Z",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "text", text: "boom" }],
        },
      }),
      line({
        type: "thinking_level_change",
        id: "t9",
        parentId: "m2",
        timestamp: "",
        thinkingLevel: "high",
      }),
      "not json at all",
    ].join("\n");

    const parsed = parsePrimeAgentSessionFile(raw);
    expect(parsed).toBeDefined();
    expect(parsed?.sessionId).toBe("sess-1");
    expect(parsed?.cwd).toBe("/home/ubuntu/project");
    expect(parsed?.name).toBe("My session");
    expect(parsed?.lastModelSlug).toBe("baseten/moonshotai/Kimi-K3");
    expect(parsed?.rlmDepth).toBe(0);
    expect(parsed?.messages).toEqual([
      { role: "user", text: "hello", timestamp: "2025-12-01T10:00:01.000Z" },
      { role: "assistant", text: "hi there", timestamp: "2025-12-01T10:00:05.000Z" },
    ]);
  });

  it("flags RLM children and rejects non-session files", () => {
    const child = parsePrimeAgentSessionFile(
      [
        line({
          type: "session",
          id: "sub-1",
          timestamp: "2025-12-01T10:00:00.000Z",
          cwd: "/home/ubuntu/project",
          parentSession: "../parent.jsonl",
          rlmDepth: 1,
        }),
      ].join("\n"),
    );
    expect(child?.rlmDepth).toBe(1);
    expect(child?.parentSession).toBe("../parent.jsonl");

    expect(parsePrimeAgentSessionFile("")).toBeUndefined();
    expect(parsePrimeAgentSessionFile(line({ type: "not-a-session" }))).toBeUndefined();
  });
});
