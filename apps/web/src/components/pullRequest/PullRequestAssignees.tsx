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
import {
  emptySelection,
  isSelected,
  selectionChanges,
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { msg, T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";

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
        <span className="text-muted-foreground">
          <T>None</T>
        </span>
      ) : (
        <span className="flex items-center -space-x-1">
          {assignees.map((actor) => (
            <span
              key={actor.login}
              className="relative flex rounded-full ring-2 ring-background hover:z-10 focus-within:z-10"
            >
              <PullRequestActorLabel actor={actor} variant="avatar" />
            </span>
          ))}
        </span>
      )}
      {canChange ? (
        <PullRequestAssigneePicker
          environmentId={environmentId}
          reference={reference}
          assignees={assignees}
          allowed={allowed}
        />
      ) : null}
    </span>
  );
}

function PullRequestAssigneePicker({
  environmentId,
  reference,
  assignees,
  allowed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /**
   * Who is assigned according to the detail, which decides which way a press goes. The candidates
   * carry the same fact as of when the menu was read, and the detail is what a change made from
   * another client refreshes.
   */
  assignees: ReadonlyArray<PullRequestActor>;
  /** False where the host would refuse this account's change. Disabled with the reason rather
   * than hidden, like the reviewer control above it. */
  allowed: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(emptySelection<PullRequestAssigneeCandidate>);

  // Mounted with the menu closed, so nothing is asked of the host until it opens.
  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.assigneeCandidates({ environmentId, input: reference }) : null,
  );
  const setAssignees = useAtomCommand(pullRequestEnvironment.setAssignees, {
    reportFailure: false,
  });

  const candidates = (candidatesQuery.data?.candidates ?? []).filter((entry) =>
    matches(entry, query),
  );

  const assignedLogins = new Set(assignees.map((actor) => actor.login.toLowerCase()));
  const isAssigned = (candidate: PullRequestAssigneeCandidate) =>
    assignedLogins.has(candidate.login.toLowerCase());

  const send = async (people: ReadonlyArray<PullRequestAssigneeCandidate>, assigned: boolean) => {
    if (people.length === 0) return;
    const logins = people.map((person) => person.login);
    const result = await setAssignees({
      environmentId,
      input: { ...reference, assignees: logins, assigned },
    });
    if (result._tag === "Success") return;
    toastManager.add({
      type: "error",
      title: assigned
        ? m(msg("Could not assign {logins}", { logins: logins.join(", ") }))
        : m(msg("Could not unassign {logins}", { logins: logins.join(", ") })),
      description: readableFailure(
        squashAtomCommandFailure(result),
        m(msg("The host refused it.")),
      ),
    });
  };

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    const { add, remove } = selectionChanges(draft, (_key, person) => isAssigned(person));
    setDraft(emptySelection());
    // GitHub caps assignees per pull request, so freeing a slot goes first.
    void send(remove, false).then(() => send(add, true));
  };

  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label={gt("Change assignees")}
      allowed={allowed}
      disabledReason={gt("Changing assignees needs triage access on this repository")}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={gt("Search assignable people")}
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel={gt("Nobody can be assigned on this repository.")}
      noMatchLabel={gt("Nobody assignable matches that.")}
      errorLabel={gt("The assignable people could not be read.")}
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel={gt("This repository has more assignable people than are listed here.")}
      candidateKey={(candidate) => candidate.login}
      onSelect={(candidate) =>
        setDraft((current) =>
          toggleSelection(current, candidate.login, candidate, isAssigned(candidate)),
        )
      }
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} className="min-w-0 flex-1 truncate" />
          {isSelected(draft, candidate.login, isAssigned(candidate)) ? (
            <CheckIcon aria-label={gt("Assigned")} className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}
