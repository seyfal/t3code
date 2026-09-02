import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { isGitRepository } from "./Utils.ts";

describe("isGitRepository", () => {
  it("accepts a real gitdir and a gitfile, rejects an empty .git directory", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-utils-"));
    try {
      const real = NodePath.join(root, "real");
      NodeFS.mkdirSync(NodePath.join(real, ".git"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(real, ".git", "HEAD"), "ref: refs/heads/main\n");
      expect(isGitRepository(real)).toBe(true);

      const worktree = NodePath.join(root, "worktree");
      NodeFS.mkdirSync(worktree, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(worktree, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      expect(isGitRepository(worktree)).toBe(true);

      const stray = NodePath.join(root, "stray");
      NodeFS.mkdirSync(NodePath.join(stray, ".git"), { recursive: true });
      expect(isGitRepository(stray)).toBe(false);

      expect(isGitRepository(NodePath.join(root, "plain"))).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
