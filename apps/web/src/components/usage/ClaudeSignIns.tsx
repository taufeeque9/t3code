import { AuthProvidersManageScope } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useState } from "react";

import { collectClaudeSignIns, type ClaudeSignInCandidate } from "./claudeSignIn";
import { ProviderLoginDialog, type ProviderLoginTarget } from "./ProviderLoginDialog";

/** One account's row. The grant belongs to the account's environment, so each row reads its own. */
function ClaudeSignInRow({
  candidate,
  onSignIn,
}: {
  readonly candidate: ClaudeSignInCandidate;
  readonly onSignIn: (target: ProviderLoginTarget) => void;
}) {
  const canManageProviders = useEnvironmentScope(candidate.environmentId, AuthProvidersManageScope);
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="min-w-0 truncate text-muted-foreground">
        {candidate.listedInNotices
          ? candidate.displayName
          : `${candidate.displayName}: ${candidate.notice}`}
      </span>
      <Button
        size="xs"
        variant="outline"
        className="ms-auto shrink-0"
        disabled={!canManageProviders}
        onClick={() =>
          onSignIn({
            environmentId: candidate.environmentId,
            instanceId: candidate.instanceId,
            displayName: candidate.displayName,
          })
        }
      >
        Sign in
      </Button>
    </div>
  );
}

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
        <ClaudeSignInRow key={candidate.key} candidate={candidate} onSignIn={setTarget} />
      ))}
      <ProviderLoginDialog
        target={target}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onSignedIn={() => {
          if (!target) return;
          // refreshModels drops the instance's cached capabilities, which still hold the old login.
          void refreshProviders({
            environmentId: target.environmentId,
            input: { instanceId: target.instanceId, refreshModels: true },
          });
        }}
      />
    </div>
  );
}
