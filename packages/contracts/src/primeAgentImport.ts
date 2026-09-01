/**
 * Importing prime-agent sessions recorded outside T3 Code.
 *
 * prime-agent's TUI and headless runs write JSONL session files under its own
 * session directory. Importing one creates (or reuses) a project rooted at
 * the session's cwd, creates a thread backfilled with the conversation's
 * user/assistant text, and copies the session file into the thread's
 * per-thread session directory so the next turn continues the conversation
 * with the agent's full context (`--session-dir` + `--continue`).
 *
 * @module primeAgentImport
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** One importable prime-agent session found on the environment's disk. */
export const PrimeAgentImportCandidate = Schema.Struct({
  /** Absolute path of the session JSONL file; the import request's key. */
  path: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  /** Latest `session_info` name, when the session was ever named. */
  name: Schema.NullOr(TrimmedNonEmptyString),
  /** First line of the first user message, for unnamed sessions. */
  preview: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: TrimmedNonEmptyString,
  lastMessageAt: Schema.NullOr(TrimmedNonEmptyString),
  messageCount: NonNegativeInt,
  /** Set when this session was already imported into a thread. */
  importedThreadId: Schema.NullOr(ThreadId),
});
export type PrimeAgentImportCandidate = typeof PrimeAgentImportCandidate.Type;

export const PrimeAgentImportCandidateList = Schema.Struct({
  sessions: Schema.Array(PrimeAgentImportCandidate),
  /** Directory that was scanned, for display and diagnostics. */
  sessionDir: TrimmedNonEmptyString,
});
export type PrimeAgentImportCandidateList = typeof PrimeAgentImportCandidateList.Type;

export const PrimeAgentImportInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type PrimeAgentImportInput = typeof PrimeAgentImportInput.Type;

export const PrimeAgentImportResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  importedMessages: NonNegativeInt,
});
export type PrimeAgentImportResult = typeof PrimeAgentImportResult.Type;

export class PrimeAgentImportError extends Schema.TaggedErrorClass<PrimeAgentImportError>()(
  "PrimeAgentImportError",
  {
    reason: Schema.Literals([
      "scanFailed",
      "notFound",
      "invalidSession",
      "alreadyImported",
      "importFailed",
    ]),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Prime Agent session import failed (${this.reason}): ${this.detail}`;
  }
}
