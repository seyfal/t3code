// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Cheap repo check used before spawning git. `.git` can be a directory (a
 * real repo has `HEAD` in it) or a file (worktrees and submodules point at
 * the real gitdir). A bare empty `.git/` directory is not a repository: git
 * itself rejects it, and treating it as one makes every checkpoint fail.
 */
export function isGitRepository(cwd: string): boolean {
  const gitPath = NodePath.join(cwd, ".git");
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.statSync(gitPath);
  } catch {
    return false;
  }
  if (stat.isFile()) {
    return true;
  }
  return stat.isDirectory() && NodeFS.existsSync(NodePath.join(gitPath, "HEAD"));
}
