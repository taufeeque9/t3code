import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import type { EnvironmentId, ProviderExtraUsage, ProviderLimitsAccount } from "@t3tools/contracts";

import { isElectron } from "../../env";
import { useProviderLimits } from "../../state/limits";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { formatCreditAmount } from "./LimitsPage.logic";
import { ProviderLoginDialog, type ProviderLoginTarget } from "./ProviderLoginDialog";

function formatReset(value: string | null): string {
  if (!value) return "Reset time unavailable";
  const reset = new Date(value);
  const remainingMs = reset.getTime() - Date.now();
  if (remainingMs <= 0) return "Resetting now";
  const minutes = Math.ceil(remainingMs / 60_000);
  let relative: string;
  if (minutes < 60) {
    relative = `${minutes}m`;
  } else if (minutes < 1_440) {
    relative = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  } else {
    relative = `${Math.floor(minutes / 1_440)}d ${Math.floor((minutes % 1_440) / 60)}h`;
  }
  return `Resets in ${relative} · ${reset.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function LimitsEmptyState({ waiting }: { readonly waiting: boolean }) {
  if (waiting) {
    return <div className="text-sm text-muted-foreground">Reading provider limits…</div>;
  }
  return (
    <div className="rounded-xl border p-5 text-sm text-muted-foreground">
      No provider accounts reported subscription limits.
    </div>
  );
}

function usageColor(value: number): string {
  if (value >= 90) return "bg-destructive";
  if (value >= 70) return "bg-amber-500";
  return "bg-emerald-500";
}

function clampUsagePercentage(value: number | null): number {
  return Math.max(0, Math.min(100, value ?? 0));
}

function ExtraUsageLimit({ usage }: { readonly usage: ProviderExtraUsage }) {
  const usedPercent = clampUsagePercentage(usage.usedPercent);
  const formatAmount = (value: number | null) =>
    formatCreditAmount(value, usage.currency, usage.decimalPlaces);

  return (
    <div className="border-t pt-5">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">Extra usage</span>
        <span className="text-sm tabular-nums">
          {formatAmount(usage.usedCredits)} of {formatAmount(usage.monthlyLimit)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${usageColor(usedPercent)}`}
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Monthly credit limit
        {usage.usedPercent === null ? "" : ` · ${usage.usedPercent.toFixed(1)}% used`}
      </p>
    </div>
  );
}

type DisplayAccount = ProviderLimitsAccount & {
  readonly environmentLabel: string;
  readonly environmentId: EnvironmentId;
};

function LimitsAccountCard({
  account,
  onSignIn,
}: {
  readonly account: DisplayAccount;
  readonly onSignIn: (target: ProviderLoginTarget) => void;
}) {
  const providerName = account.driver === "claudeAgent" ? "Claude" : "Codex";
  // Only Claude exposes a sign-in T3 Code can drive, and only a card that is
  // not reporting limits has anything to fix.
  const canSignIn = account.driver === "claudeAgent" && account.status !== "ready";

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">{account.displayName}</h3>
          <p className="text-xs text-muted-foreground">
            {[account.accountLabel, account.plan, account.environmentLabel]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <span className="rounded-full bg-muted px-2 py-1 text-[11px] capitalize text-muted-foreground">
          {providerName}
        </span>
      </div>
      {account.status !== "ready" ? (
        <div className="mt-5 space-y-3">
          <p className="text-sm text-muted-foreground">{account.detail}</p>
          {canSignIn ? (
            <Button
              onClick={() =>
                onSignIn({
                  environmentId: account.environmentId,
                  instanceId: account.instanceId,
                  displayName: account.displayName,
                })
              }
              size="sm"
              variant="outline"
            >
              Sign in
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {account.buckets.map((bucket) => {
            const used = clampUsagePercentage(bucket.usedPercent);
            return (
              <div key={bucket.id}>
                <div className="mb-1.5 flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium">{bucket.label}</span>
                  <span className="text-sm tabular-nums">
                    {bucket.usedPercent == null ? "—" : `${bucket.usedPercent}% used`}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${usageColor(used)}`}
                    style={{ width: `${used}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {formatReset(bucket.resetsAt)}
                </p>
              </div>
            );
          })}
          {account.extraUsage ? <ExtraUsageLimit usage={account.extraUsage} /> : null}
        </div>
      )}
    </section>
  );
}

export function LimitsPage() {
  const { environments, refresh } = useProviderLimits();
  const [loginTarget, setLoginTarget] = useState<ProviderLoginTarget | null>(null);
  const waiting = environments.some((environment) => environment.waiting);
  const failures = environments.filter((environment) => environment.detail !== null);
  const accounts = environments.flatMap((environment) =>
    environment.accounts.map((account) => ({
      ...account,
      environmentLabel: environment.environmentLabel,
      environmentId: environment.environmentId,
    })),
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full items-center gap-3">
            <WorkspaceBreadcrumb ariaLabel="Limits breadcrumb">
              <WorkspaceBreadcrumbItem current>
                <h1>Limits</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <Button
              aria-label="Refresh limits"
              className="ms-auto"
              disabled={waiting}
              onClick={refresh}
              size="icon-sm"
              variant="ghost"
            >
              <RefreshCwIcon className={waiting ? "size-3.5 animate-spin" : "size-3.5"} />
            </Button>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            <div className="mb-6">
              <h2 className="text-xl font-semibold">Subscription limits</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Provider-reported usage windows. These are separate from token activity on the Usage
                page.
              </p>
            </div>
            {failures.length > 0 ? (
              <div className="mb-4 space-y-2">
                {failures.map((environment) => (
                  <div
                    className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
                    key={environment.environmentId}
                  >
                    <span className="font-medium">{environment.environmentLabel}:</span>{" "}
                    <span className="text-muted-foreground">{environment.detail}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {accounts.length === 0 ? (
              <LimitsEmptyState waiting={waiting} />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {accounts.map((account) => (
                  <LimitsAccountCard
                    account={account}
                    key={`${account.environmentLabel}:${account.instanceId}`}
                    onSignIn={setLoginTarget}
                  />
                ))}
              </div>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      <ProviderLoginDialog
        onOpenChange={(open) => {
          if (!open) setLoginTarget(null);
        }}
        onSignedIn={refresh}
        target={loginTarget}
      />
    </SidebarInset>
  );
}
