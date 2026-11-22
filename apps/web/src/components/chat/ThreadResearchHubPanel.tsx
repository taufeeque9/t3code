import type { EnvironmentId, OrchestrationV2ResearchHubLink, ThreadId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { FlaskConicalIcon, NotebookTextIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { cn } from "../../lib/utils";
import { useQuietThreadShell, useQuietThreadVisibleTurnItems } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/** A note lives at `<folder>/note.md`, so its folder names it. */
function pageName(link: OrchestrationV2ResearchHubLink) {
  const segments = link.path.split("/");
  const last = segments.at(-1) ?? link.path;
  return link.project === "notes" && last === "note.md" && segments.length > 1
    ? (segments.at(-2) ?? last)
    : last.replace(/\.md$/u, "");
}

export function ThreadResearchHubPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const m = useMessages();
  const threadRef = { environmentId: props.environmentId, threadId: props.threadId };
  const shell = useQuietThreadShell(threadRef);
  const latestSettledMessage = useQuietThreadVisibleTurnItems(threadRef).findLast(
    ({ item }) =>
      item.type === "user_message" || (item.type === "assistant_message" && !item.streaming),
  );
  const settledRevision = `${latestSettledMessage?.item.id ?? ""}:${shell?.latestRun?.completedAt ?? ""}`;
  const openLink = useOpenLink(threadRef);
  const query = useEnvironmentQuery(
    orchestrationEnvironment.researchHubLinks({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
    m,
  );
  const { refresh } = query;
  const askedAt = useRef(settledRevision);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-asks the server once the thread settles a message, keeping the shown links meanwhile
  useEffect(() => {
    if (askedAt.current === settledRevision) return;
    askedAt.current = settledRevision;
    refresh();
  }, [refresh, settledRevision]);
  const links = query.data?.links ?? [];
  if (links.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-research-hub-heading"
      title={gt("Research hub")}
      data-thread-research-hub-panel
    >
      <div className="flex max-h-[13.5rem] flex-col overflow-y-auto">
        {links.map((link) => {
          const Icon = link.project === "notes" ? NotebookTextIcon : FlaskConicalIcon;
          const name = pageName(link);
          return (
            <ThreadDetailsControl
              key={`${link.project}:${link.path}`}
              part="row"
              render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
              title={link.path}
              aria-label={
                link.project === "notes"
                  ? gt("Note {name}", { name })
                  : gt("Study {name}", { name })
              }
              onClick={(event) => {
                event.preventDefault();
                openLink(link.url, { event }).catch((error: unknown) =>
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: gt("Unable to open link"),
                      description: error instanceof Error ? error.message : String(error),
                    }),
                  ),
                );
              }}
            >
              <Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                {name}
              </span>
            </ThreadDetailsControl>
          );
        })}
      </div>
    </ThreadDetailsSection>
  );
}
