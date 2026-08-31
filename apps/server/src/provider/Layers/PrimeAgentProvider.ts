import {
  type PrimeAgentSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { discoverPrimeAgentSkills } from "../Drivers/PrimeAgentSkills.ts";

const PRIME_AGENT_PRESENTATION = {
  displayName: "Prime Agent",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  // Prime Agent's ACP mode never sends `session/request_permission` (its
  // tool is a trusted Python REPL, "a trusted-code boundary, not a
  // sandbox"), so approval-based runtime modes cannot gate anything.
  // Advertise the one mode that tells the truth.
  supportedRuntimeModes: ["full-access"],
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `prime-agent model list` may refresh provider catalogs over the network.
const PRIME_AGENT_MODEL_LIST_TIMEOUT_MS = 10_000;

const PRIME_AGENT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    // Prime Agent's `--model` flag takes a pattern, resolved against whatever
    // providers the user has authenticated inside Prime Agent itself. "sonnet"
    // is a safe pattern for the common Claude subscription path; real catalogs
    // come from `prime-agent model list` or the customModels setting.
    slug: "sonnet",
    name: "Claude Sonnet (via Prime Agent)",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialPrimeAgentProviderSnapshot(
  primeAgentSettings: PrimeAgentSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = primeAgentModelsFromSettings(primeAgentSettings.customModels);

    if (!primeAgentSettings.enabled) {
      return buildServerProvider({
        presentation: PRIME_AGENT_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Prime Agent is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Prime Agent CLI availability...",
      },
    });
  });
}

function primeAgentModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = PRIME_AGENT_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Parse `prime-agent model list` output (verified against 0.8.1's
 * `cli/list-models.ts`): a padded-column table whose header row starts with
 * `provider` followed by `model`, one model per subsequent row. Rows become
 * `provider/id` slugs — the exact pattern form `--model` accepts. Returns []
 * for anything unrecognized so the caller falls back to the built-in list.
 */
export function parsePrimeAgentModelListOutput(output: string): ReadonlyArray<ServerProviderModel> {
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^provider\s+model(\s|$)/.test(line.trim()));
  if (headerIndex < 0) {
    return [];
  }
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [provider, modelId] = trimmed.split(/\s{2,}/);
    if (!provider?.trim() || !modelId?.trim()) {
      continue;
    }
    const slug = `${provider.trim()}/${modelId.trim()}`;
    if (seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

const runPrimeAgentCommand = (
  primeAgentSettings: PrimeAgentSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = primeAgentSettings.binaryPath || "prime-agent";
    const spawnCommand = yield* resolveSpawnCommand(command, [...args], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkPrimeAgentProviderStatus = Effect.fn("checkPrimeAgentProviderStatus")(function* (
  primeAgentSettings: PrimeAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = primeAgentModelsFromSettings(primeAgentSettings.customModels);

  if (!primeAgentSettings.enabled) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Prime Agent is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runPrimeAgentCommand(
    primeAgentSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("PrimeAgent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: primeAgentSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Prime Agent CLI (`prime-agent`) is not installed or not on PATH."
          : "Failed to execute PrimeAgent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: primeAgentSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Prime Agent CLI is installed but timed out while running `prime-agent --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("PrimeAgent CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: primeAgentSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Prime Agent CLI is installed but failed to run.",
      },
    });
  }

  const skills = yield* discoverPrimeAgentSkills(primeAgentSettings, environment, cwd);

  // Auth + model discovery ride on `prime-agent model list`. Verified against
  // 0.8.1: ACP startup succeeds with no credentials at all (`initialize` and
  // `session/new` both answer; only `session/prompt` fails with "No API key
  // found"), and `session/new` returns nothing but a sessionId — so an ACP
  // spawn can detect neither auth state nor the model catalog. `model list`
  // exits 0 in both states; the "No models available" text is the logged-out
  // signal, and the table rows are the authenticated catalog.
  const modelListResult = yield* runPrimeAgentCommand(
    primeAgentSettings,
    ["model", "list"],
    environment,
  ).pipe(Effect.timeoutOption(PRIME_AGENT_MODEL_LIST_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(modelListResult) || Option.isNone(modelListResult.success)) {
    if (Result.isFailure(modelListResult)) {
      yield* Effect.logWarning("PrimeAgent model list probe failed.", {
        errorTag: modelListResult.failure._tag,
      });
    } else {
      yield* Effect.logWarning(
        `PrimeAgent model list probe timed out after ${PRIME_AGENT_MODEL_LIST_TIMEOUT_MS}ms.`,
      );
    }
    // The binary itself runs (version probe passed); only the auth/catalog
    // signal is missing. Stay usable with the fallback models.
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: primeAgentSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
      },
    });
  }

  const modelListOutput = modelListResult.success.value;
  const modelListText = `${modelListOutput.stdout}\n${modelListOutput.stderr}`;
  if (modelListText.includes("No models available")) {
    return buildServerProvider({
      presentation: PRIME_AGENT_PRESENTATION,
      enabled: primeAgentSettings.enabled,
      checkedAt,
      models: fallbackModels,
      skills,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message:
          "Prime Agent has no provider credentials. Run `prime-agent` and use /login, or set a provider API key (e.g. ANTHROPIC_API_KEY).",
      },
    });
  }

  const discoveredModels = parsePrimeAgentModelListOutput(modelListText);
  const models =
    discoveredModels.length > 0
      ? primeAgentModelsFromSettings(primeAgentSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: PRIME_AGENT_PRESENTATION,
    enabled: primeAgentSettings.enabled,
    checkedAt,
    models,
    skills,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "authenticated" },
    },
  });
});

export const enrichPrimeAgentSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("PrimeAgent version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
