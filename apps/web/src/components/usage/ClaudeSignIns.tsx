import type { EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useState } from "react";

import { collectClaudeSignIns } from "./claudeSignIn";
import { ProviderLoginDialog, type ProviderLoginTarget } from "./ProviderLoginDialog";

/**
 * The way back in for a Claude account whose credential stopped working, next
 * to the notice that says so. Renders nothing when every account reports.
 */
export function ClaudeSignIns({
  presentations,
}: {
  readonly presentations: Parameters<typeof collectClaudeSignIns>[0];
}) {
  const [target, setTarget] = useState<ProviderLoginTarget | null>(null);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const candidates = collectClaudeSignIns(presentations);
  if (candidates.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {candidates.map((candidate) => (
        <div key={candidate.key} className="flex items-center gap-3 text-xs">
          <span className="min-w-0 truncate text-muted-foreground">
            {candidate.listedInNotices
              ? candidate.displayName
              : `${candidate.displayName}: ${candidate.notice}`}
          </span>
          <Button
            size="xs"
            variant="outline"
            className="ms-auto shrink-0"
            onClick={() =>
              setTarget({
                environmentId: candidate.environmentId,
                instanceId: candidate.instanceId,
                displayName: candidate.displayName,
              })
            }
          >
            Sign in
          </Button>
        </div>
      ))}
      <ProviderLoginDialog
        target={target}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onSignedIn={() => {
          const environmentId: EnvironmentId | undefined = target?.environmentId;
          if (environmentId) void refreshProviders({ environmentId, input: {} });
        }}
      />
    </div>
  );
}
