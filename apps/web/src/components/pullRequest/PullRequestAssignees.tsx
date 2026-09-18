/**
 * Assigning somebody, and taking them off, from the row that says who is already assigned.
 *
 * The assignable people are read only once this menu opens, for the reason the reviewer menu
 * reads its people then.
 */
import type {
  EnvironmentId,
  PullRequestActor,
  PullRequestAssigneeCandidate,
  PullRequestRef,
} from "@t3tools/contracts";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";

/** Narrows only what arrived: the host is asked once, when the menu opens. */
function matches(candidate: PullRequestAssigneeCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.login.toLowerCase().includes(needle) ||
    (candidate.name ?? "").toLowerCase().includes(needle)
  );
}

/** Who is assigned, as the same stack of faces the reviewer row shows, and the menu to change it. */
export function PullRequestAssignees({
  environmentId,
  reference,
  assignees,
  canChange,
  allowed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  assignees: ReadonlyArray<PullRequestActor>;
  /** The host can change assignees at all; `allowed` says whether this account may. */
  canChange: boolean;
  allowed: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {assignees.length === 0 ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <span className="flex items-center -space-x-1">
          {assignees.map((actor) => (
            <PullRequestActorLabel
              key={actor.login}
              actor={actor}
              className="relative gap-0 hover:z-10 [&>img]:ring-2 [&>img]:ring-background [&>span:first-child]:ring-2 [&>span:first-child]:ring-background [&>span:last-child]:sr-only"
            />
          ))}
        </span>
      )}
      {canChange ? (
        <PullRequestAssigneePicker
          environmentId={environmentId}
          reference={reference}
          allowed={allowed}
        />
      ) : null}
    </span>
  );
}

function PullRequestAssigneePicker({
  environmentId,
  reference,
  allowed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** False where the host would refuse this account's change. Disabled with the reason rather
   * than hidden, like the reviewer control above it. */
  allowed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.assigneeCandidates({ environmentId, input: reference }) : null,
  );
  const setAssignees = useAtomCommand(pullRequestEnvironment.setAssignees, {
    reportFailure: false,
  });

  const candidates = useMemo(
    () => (candidatesQuery.data?.candidates ?? []).filter((entry) => matches(entry, query)),
    [candidatesQuery.data, query],
  );

  const toggle = async (candidate: PullRequestAssigneeCandidate) => {
    if (pending !== null) return;
    setPending(candidate.login);
    const result = await setAssignees({
      environmentId,
      input: { ...reference, assignees: [candidate.login], assigned: !candidate.isAssigned },
    });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: candidate.isAssigned
          ? `Could not unassign ${candidate.login}`
          : `Could not assign ${candidate.login}`,
        description: readableFailure(squashAtomCommandFailure(result), "The host refused it."),
      });
    }
  };

  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label="Change assignees"
      allowed={allowed}
      disabledReason="Changing assignees needs triage access on this repository"
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search assignable people"
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel="Nobody can be assigned on this repository."
      noMatchLabel="Nobody assignable matches that."
      errorLabel="The assignable people could not be read."
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel="This repository has more assignable people than are listed here."
      candidateKey={(candidate) => candidate.login}
      disabled={pending !== null}
      onSelect={(candidate) => void toggle(candidate)}
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} className="min-w-0 flex-1 truncate" />
          {candidate.isAssigned ? (
            <CheckIcon aria-label="Assigned" className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}
