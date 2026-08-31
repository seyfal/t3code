/**
 * PrimeAgentSkills — skill discovery for the `$` picker via a filesystem scan.
 *
 * Unlike Grok (`grok inspect --json`) or Codex (`skills/list`), Prime Agent
 * has no CLI command that dumps its skill catalog, so discovery scans the two
 * conventional locations directly:
 *
 *   - user skills:    `$PRIME_AGENT_CODING_AGENT_DIR/skills` (default
 *                     `~/.prime/agent/skills`)
 *   - project skills: `<cwd>/.prime/agent/skills`
 *
 * Per Prime Agent's package conventions, a skill is a directory containing a
 * `SKILL.md` (searched recursively, a few levels deep) or a top-level `.md`
 * file. This scan cannot see skills contributed by installed Prime Agent
 * packages or honor per-skill disable settings — it is a best-effort catalog
 * for the picker, not the agent's authoritative view. Discovery never fails:
 * missing directories, permission errors, or malformed frontmatter yield an
 * empty (or partial) list, never a degraded provider snapshot.
 *
 * @module provider/Drivers/PrimeAgentSkills
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { PrimeAgentSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

const PRIME_AGENT_SKILLS_MAX_DEPTH = 3;

interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
}

/** Minimal frontmatter reader: `name:` / `description:` from a leading `---` block. */
export function parsePrimeAgentSkillFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {};
  }
  let name: string | undefined;
  let description: string | undefined;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") {
      break;
    }
    const match = /^(name|description):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const value = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (match[1] === "name" && value) {
      name = value;
    } else if (match[1] === "description" && value) {
      description = value;
    }
  }
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

function resolvePrimeAgentUserSkillsDir(environment: NodeJS.ProcessEnv): string {
  const configuredHome = environment.PRIME_AGENT_CODING_AGENT_DIR?.trim();
  const agentHome = configuredHome || join(environment.HOME?.trim() || homedir(), ".prime", "agent");
  return join(agentHome, "skills");
}

async function collectSkillsFromDirectory(
  root: string,
  scope: string,
  sink: Map<string, ServerProviderSkill>,
): Promise<void> {
  const { readdir, readFile } = await import("node:fs/promises");

  const walk = async (directory: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < PRIME_AGENT_SKILLS_MAX_DEPTH) {
          await walk(entryPath, depth + 1);
        }
        continue;
      }
      const isSkillManifest = entry.name === "SKILL.md";
      const isTopLevelSkillFile =
        depth === 0 && entry.name.endsWith(".md") && entry.name !== "SKILL.md";
      if (!isSkillManifest && !isTopLevelSkillFile) {
        continue;
      }
      let content = "";
      try {
        content = await readFile(entryPath, "utf8");
      } catch {
        continue;
      }
      const frontmatter = parsePrimeAgentSkillFrontmatter(content);
      const fallbackName = isSkillManifest
        ? (directory.split(/[\\/]/).pop() ?? "")
        : entry.name.replace(/\.md$/, "");
      const name = frontmatter.name ?? fallbackName;
      if (!name || sink.has(name)) {
        continue;
      }
      sink.set(name, {
        name,
        path: entryPath,
        enabled: true,
        scope,
        ...(frontmatter.description ? { description: frontmatter.description } : {}),
      });
    }
  };

  await walk(root, 0);
}

/**
 * Scan the user and project skill directories. Signature intentionally
 * matches the other drivers' `discover<Provider>Skills` helpers (settings,
 * environment, cwd) even though this implementation never spawns a process;
 * the unused `ChildProcessSpawner` requirement is omitted.
 */
export const discoverPrimeAgentSkills = Effect.fn("discoverPrimeAgentSkills")(function* (
  _primeAgentSettings: Pick<PrimeAgentSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const skills = yield* Effect.promise<ReadonlyArray<ServerProviderSkill>>(async () => {
    try {
      const sink = new Map<string, ServerProviderSkill>();
      // Project skills first so they win name collisions over user skills,
      // matching Prime Agent's own project-over-user precedence.
      if (cwd?.trim()) {
        await collectSkillsFromDirectory(
          join(cwd.trim(), ".prime", "agent", "skills"),
          "project",
          sink,
        );
      }
      await collectSkillsFromDirectory(resolvePrimeAgentUserSkillsDir(environment), "user", sink);
      return [...sink.values()].sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return [];
    }
  });
  if (skills.length === 0) {
    yield* Effect.logDebug("Prime Agent skill discovery found no skills.");
  }
  return skills;
});
