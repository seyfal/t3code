import { type PrimeAgentSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

// Prime Agent's ACP surface does not expose an `authenticate` method:
// credentials come from `/login` state under ~/.prime/agent or provider env
// vars (e.g. ANTHROPIC_API_KEY) read by the spawned process itself. The
// runtime therefore skips the authenticate call entirely (authMethodId: null).
const PRIME_AGENT_DRIVER_KIND = ProviderDriverKind.make("primeAgent");

type PrimeAgentAcpRuntimePrimeAgentSettings = Pick<PrimeAgentSettings, "binaryPath">;

interface PrimeAgentAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn" | "resumeSessionId"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly primeAgentSettings: PrimeAgentAcpRuntimePrimeAgentSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /** Model to pin via `--model` at spawn; later switches use config options. */
  readonly modelId?: string | undefined;
  /** Initial thinking level via `--thinking`; later switches use config options. */
  readonly thinkingLevel?: string | undefined;
  /**
   * Directory Prime Agent stores its session JSONL in (`--session-dir`).
   * The adapter passes a per-thread directory so `--continue` can find the
   * thread's one session deterministically. Deliberately NOT forwarded to
   * the shared ACP runtime: Prime Agent has no `session/load`, so the
   * runtime always performs `session/new` against the underlying session
   * fixed at process startup.
   */
  readonly sessionDir?: string | undefined;
  /**
   * Resume the most recent session in `sessionDir` via `--continue`.
   * Verified against prime-agent 0.8.1: the ACP `session/new` response's
   * sessionId is a fresh random UUID unrelated to the on-disk session file
   * (`acp-mode.ts` calls `randomUUID()`), so `--resume <acpSessionId>` can
   * never match a saved session. `--continue` scoped to the per-thread
   * `--session-dir` is the reliable mapping.
   */
  readonly continueConversation?: boolean | undefined;
  /**
   * Do not save a session file (`--no-session`). For throwaway runs such as
   * commit-message generation, which would otherwise litter the user's
   * session directory with one file per invocation.
   */
  readonly noSession?: boolean | undefined;
}

/**
 * Model, thinking level, and session resume ride on argv at spawn time; a
 * patched build (>= the acp-config-options branch) can then move model and
 * thinking mid-session via `session/set_config_option`. `--approval` gates
 * every tool call behind `session/request_permission`, which is how T3's
 * `approval-required` runtime mode becomes real: without it the agent's tool
 * is a trusted Python REPL that runs everything unasked.
 */
export function primeAgentAcpSpawnArgs(options?: {
  readonly modelId?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly approval?: boolean | undefined;
  readonly sessionDir?: string | undefined;
  readonly continueConversation?: boolean | undefined;
  readonly noSession?: boolean | undefined;
}): ReadonlyArray<string> {
  return [
    "--mode",
    "acp",
    ...(options?.modelId ? ["--model", options.modelId] : []),
    ...(options?.thinkingLevel ? ["--thinking", options.thinkingLevel] : []),
    // Unknown flags land in prime-agent's tolerated unknown-flag map, so a
    // pre-approval binary starts fine and simply never asks. The adapter's
    // permission handler then never fires, which degrades approval-required
    // to full access rather than breaking the thread.
    ...(options?.approval ? ["--approval"] : []),
    ...(options?.sessionDir ? ["--session-dir", options.sessionDir] : []),
    // `--continue` falls back to a fresh session when the directory holds no
    // matching session, so a lost session file degrades to a new
    // conversation instead of a dead thread.
    ...(options?.continueConversation ? ["--continue"] : []),
    ...(options?.noSession ? ["--no-session"] : []),
  ];
}

export function buildPrimeAgentAcpSpawnInput(
  primeAgentSettings: PrimeAgentAcpRuntimePrimeAgentSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: {
    readonly modelId?: string | undefined;
    readonly thinkingLevel?: string | undefined;
    readonly approval?: boolean | undefined;
    readonly sessionDir?: string | undefined;
    readonly continueConversation?: boolean | undefined;
    readonly noSession?: boolean | undefined;
  },
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: primeAgentSettings?.binaryPath || "prime-agent",
    args: [...primeAgentAcpSpawnArgs(options)],
    cwd,
    env: {
      ...environment,
    },
  };
}

export const makePrimeAgentAcpRuntime = (
  input: PrimeAgentAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { modelId, thinkingLevel, sessionDir, continueConversation, noSession, ...runtimeInput } =
      input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeInput,
        spawn: buildPrimeAgentAcpSpawnInput(
          input.primeAgentSettings,
          input.cwd,
          input.environment,
          {
            modelId,
            thinkingLevel,
            approval: input.runtimeMode === "approval-required",
            sessionDir,
            continueConversation,
            noSession,
          },
        ),
        authMethodId: null,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return runtime;
  });

export function resolvePrimeAgentAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "sonnet";
  return normalizeModelSlug(base, PRIME_AGENT_DRIVER_KIND) ?? "sonnet";
}

const PRIME_AGENT_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function isValidPrimeAgentReasoningEffortToken(value: string): boolean {
  return PRIME_AGENT_REASONING_EFFORT_TOKEN.test(value);
}

export function normalizePrimeAgentReasoningEffort(value: string | undefined): string | undefined {
  const effort = value?.trim();
  return effort && isValidPrimeAgentReasoningEffortToken(effort) ? effort : undefined;
}

function findPrimeAgentConfigOptionByCategory(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  category: "model" | "thought_level",
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions?.find((option) => option.category === category);
}

function configOptionCurrentValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): string | undefined {
  if (option?.type !== "select") {
    return undefined;
  }
  const value = option.currentValue?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function currentPrimeAgentModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  // A patched prime-agent reports the session model as a `model`-category
  // config option (values are `provider/model-id`, the `--model` pattern
  // form). The legacy `models` state never shipped in prime-agent but stays
  // as a fallback for spec-faithful builds.
  return (
    configOptionCurrentValue(
      findPrimeAgentConfigOptionByCategory(sessionSetupResult.configOptions, "model"),
    ) ??
    (sessionSetupResult.models?.currentModelId?.trim() || undefined)
  );
}

export function currentPrimeAgentReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const fromConfigOption = configOptionCurrentValue(
    findPrimeAgentConfigOptionByCategory(sessionSetupResult.configOptions, "thought_level"),
  );
  if (fromConfigOption) {
    return normalizePrimeAgentReasoningEffort(fromConfigOption);
  }
  const modelState = sessionSetupResult.models;
  if (!modelState) {
    return undefined;
  }
  const currentModelId = modelState.currentModelId.trim();
  if (currentModelId.length === 0) {
    return undefined;
  }
  const currentModel = modelState.availableModels.find(
    (model) => model.modelId.trim() === currentModelId,
  );
  const reasoningEffort = currentModel?._meta?.reasoningEffort;
  return typeof reasoningEffort === "string"
    ? normalizePrimeAgentReasoningEffort(reasoningEffort)
    : undefined;
}

export function applyPrimeAgentAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // A patched prime-agent exposes `model` and `thought_level` config options,
  // so both switch in-session via `session/set_config_option` (the runtime
  // no-ops when the value already matches). A stock 0.8.1 binary reports no
  // config options at all; there the selection silently keeps the model the
  // process was spawned with — the same model the thread was already using.
  // Requested values outside the advertised catalog are skipped rather than
  // failing the turn: a stale client picker must not kill a healthy session.
  return Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    let boundModelId = input.currentModelId ?? input.requestedModelId;

    const modelOption = findPrimeAgentConfigOptionByCategory(configOptions, "model");
    if (
      modelOption &&
      input.requestedModelId &&
      collectSessionConfigOptionValues(modelOption).includes(input.requestedModelId)
    ) {
      yield* input.runtime
        .setConfigOption(modelOption.id, input.requestedModelId)
        .pipe(Effect.mapError(input.mapError));
      boundModelId = input.requestedModelId;
    }

    // Re-read after the model write: the available thinking levels are
    // per-model in prime-agent, so a model switch invalidates the list
    // fetched above (the runtime refreshed its snapshot from the
    // set_config_option response).
    const refreshedOptions = yield* input.runtime.getConfigOptions;
    const thinkingOption = findPrimeAgentConfigOptionByCategory(refreshedOptions, "thought_level");
    const requestedEffort = normalizePrimeAgentReasoningEffort(input.requestedReasoningEffort);
    if (
      thinkingOption &&
      requestedEffort &&
      collectSessionConfigOptionValues(thinkingOption).includes(requestedEffort)
    ) {
      // A level the new model does not support must never kill the turn:
      // thinking is a preference, the prompt is the work. Log and move on.
      yield* input.runtime
        .setConfigOption(thinkingOption.id, requestedEffort)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("PrimeAgent thinking-level selection skipped.", { cause }),
          ),
        );
    }

    return boundModelId;
  });
}
