/**
 * Import prime-agent sessions recorded outside T3 Code (TUI or headless runs
 * on the environment) into T3 threads. Listing and importing both run on the
 * environment that owns the session files; this section only renders rows.
 */
import { useCallback, useState } from "react";
import { ChevronDownIcon, DownloadIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import type { EnvironmentId, PrimeAgentImportCandidate } from "@t3tools/contracts";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { toastManager } from "../ui/toast";

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function PrimeAgentImportSection({
  environmentId,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ReadonlyArray<PrimeAgentImportCandidate> | null>(null);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [importedPaths, setImportedPaths] = useState<ReadonlySet<string>>(() => new Set());

  const listImports = useAtomCommand(serverEnvironment.listPrimeAgentImports, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importPrimeAgentSession, {
    reportFailure: false,
  });

  const loadSessions = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    void (async () => {
      const result = await listImports({ environmentId, input: {} });
      setIsLoading(false);
      if (result._tag === "Success") {
        setSessions(result.value.sessions);
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        setLoadError("Could not read prime-agent sessions on this environment.");
      }
    })();
  }, [environmentId, listImports]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen && sessions === null && !isLoading) {
        loadSessions();
      }
    },
    [isLoading, loadSessions, sessions],
  );

  const runImport = useCallback(
    (candidate: PrimeAgentImportCandidate) => {
      setImportingPath(candidate.path);
      void (async () => {
        const result = await importSession({
          environmentId,
          input: { path: candidate.path },
        });
        setImportingPath(null);
        if (result._tag === "Success") {
          setImportedPaths((previous) => new Set(previous).add(candidate.path));
          toastManager.add({
            type: "success",
            title: "Session imported",
            description: `${result.value.importedMessages} messages are now a T3 thread. The next turn continues the conversation.`,
          });
          return;
        }
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Import failed",
            description:
              failure instanceof Error ? failure.message : "The session could not be imported.",
          });
        }
      })();
    },
    [environmentId, importSession],
  );

  const importableSessions = sessions ?? [];

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} className="mt-1">
      <CollapsibleTrigger className="flex h-10 w-full items-center gap-2 px-3 text-xs text-muted-foreground hover:text-foreground sm:px-4">
        <ChevronDownIcon className={cn("size-3 transition-transform", open && "rotate-180")} />
        Import Prime Agent sessions
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mx-3 mb-3 space-y-2 sm:mx-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Conversations started outside T3 Code (for example in the prime-agent terminal on this
              environment) can be pulled in as threads. The imported thread keeps the full agent
              context, so the next turn continues where the conversation left off.
            </p>
            <Button
              size="icon-micro"
              variant="ghost-muted"
              disabled={isLoading}
              onClick={loadSessions}
              aria-label="Refresh importable sessions"
            >
              {isLoading ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
            </Button>
          </div>
          {loadError ? <p className="text-xs text-destructive">{loadError}</p> : null}
          {sessions !== null && importableSessions.length === 0 && !loadError ? (
            <p className="text-xs text-muted-foreground">
              No importable sessions found on this environment.
            </p>
          ) : null}
          {importableSessions.length > 0 ? (
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
              {importableSessions.map((candidate) => {
                const alreadyImported =
                  candidate.importedThreadId !== null || importedPaths.has(candidate.path);
                const label = candidate.name ?? candidate.preview ?? candidate.sessionId;
                return (
                  <div
                    key={candidate.path}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-xs text-foreground">{label}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {candidate.cwd} · {candidate.messageCount} messages
                        {formatWhen(candidate.lastMessageAt ?? candidate.startedAt)
                          ? ` · ${formatWhen(candidate.lastMessageAt ?? candidate.startedAt)}`
                          : ""}
                      </p>
                    </div>
                    {alreadyImported ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">Imported</span>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        className="shrink-0"
                        disabled={readOnly || importingPath !== null}
                        onClick={() => runImport(candidate)}
                      >
                        {importingPath === candidate.path ? (
                          <LoaderIcon className="size-3 animate-spin" />
                        ) : (
                          <DownloadIcon className="size-3" />
                        )}
                        Import
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
