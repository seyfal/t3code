import { type PrimeAgentSettings, ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

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
  /** Model to pin via `--model` at spawn; ACP-level set_model is unsupported. */
  readonly modelId?: string | undefined;
  /**
   * Prime Agent session to resume via `--resume` at spawn. Deliberately NOT
   * forwarded to the shared ACP runtime: Prime Agent has no `session/load`,
   * so the runtime always performs `session/new` against the (already
   * resumed) underlying session fixed at process startup.
   */
  readonly resumeSessionId?: string | undefined;
}

/**
 * Prime Agent's ACP mode has no permission-mode CLI flags: the agent's tool
 * is a trusted Python REPL ("a trusted-code boundary, not a sandbox" per its
 * ACP docs), so every runtime mode maps to the same invocation. Model and
 * session resume cannot be changed over ACP (`session/set_model` and
 * `session/load` are unsupported), so both ride on argv at spawn time.
 */
export function primeAgentAcpSpawnArgs(options?: {
  readonly modelId?: string | undefined;
  readonly resumeSessionId?: string | undefined;
}): ReadonlyArray<string> {
  return [
    "--mode",
    "acp",
    ...(options?.modelId ? ["--model", options.modelId] : []),
    ...(options?.resumeSessionId ? ["--resume", options.resumeSessionId] : []),
  ];
}

export function buildPrimeAgentAcpSpawnInput(
  primeAgentSettings: PrimeAgentAcpRuntimePrimeAgentSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: {
    readonly modelId?: string | undefined;
    readonly resumeSessionId?: string | undefined;
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
    const { modelId, resumeSessionId, ...runtimeInput } = input;
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeInput,
        spawn: buildPrimeAgentAcpSpawnInput(input.primeAgentSettings, input.cwd, input.environment, {
          modelId,
          resumeSessionId,
        }),
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

export function currentPrimeAgentModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function currentPrimeAgentReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
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
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  // Prime Agent does not support `session/set_model`: the model is fixed at
  // process startup via `--model`. When the session already reports a model
  // (via `session/new`'s optional model state) it wins; otherwise the
  // requested model is assumed to be the one pinned on argv. A mid-session
  // model change therefore requires a session restart, which the adapter's
  // resume path performs on the next turn with a different selection.
  return Effect.succeed(input.currentModelId ?? input.requestedModelId);
}
