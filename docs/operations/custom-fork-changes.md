# Custom fork inventory

Everything this fork carries on top of `pingdotgg/t3code@main`, so an upstream
merge can tell fork work from upstream work without reading history. Update this
file in the same commit that adds, changes, or retires a fork feature.

Regenerate the raw picture with:

```bash
git diff --name-only upstream/main...custom | rg -v '^\.repos/'
git log --oneline --no-merges upstream/main..custom
```

The three-dot diff isolates fork changes since the shared ancestor. A direct
`upstream/main` versus `custom` diff also includes upstream changes not yet merged.

Each entry records why the fork carries it and what a future merge should do
when upstream moves into the same area. See the conflict rule in `AGENTS.md`.
Client additions below are web/desktop only unless mobile is explicitly listed.

## Keep: no upstream equivalent

### Custom desktop build and self-updater

The reason the fork exists: an independently branded, self-installing build.

- `apps/desktop/package.json` (`productName`), `apps/desktop/src/app/DesktopEnvironment.ts`
  (app base name, `appUserModelId`)
- `scripts/build-desktop-artifact.ts` (`appId`, artifact name, URL schemes) and its test
- `scripts/custom/update-installed-app.sh` and its test. Its dirty-tree guard
  checks tracked changes only: the desktop build emits `.d.ts` beside its
  sources, and counting untracked files let the updater's own output block
  every later run until the checkout was cleaned by hand. Its active-session
  guard counts live Orchestration V2 runs in `statev2.sqlite`, falling back to
  the V1 session table in `state.sqlite` until a V2 build has seeded it. With
  no `-shm` file nothing has the WAL database open, and a read-only connection
  cannot create one, so the guard reads it as immutable; otherwise an install
  that broke the backend could never be replaced.
  Dependency installation sets `CI=true` so pnpm can replace a stale layout
  without a TTY. Staged bundles are signed with a stable local identity and
  verified before installation; preserving it avoids changing macOS's app identity
  on each update. Installation waits for a manual quit; `--after-app-exit`
  installs the staged build and relaunches without initiating that quit.
- `.gitignore` ignores those generated `scripts/lib/*.d.ts`
- `.github/workflows/custom-ci.yml`, `.github/workflows/custom-upstream-sync.yml`
- `.github/workflows/ci.yml` restricts upstream's CI to `main` so fork branches do not run it
- `AGENTS.md` adds the fork's deployment and conflict-resolution rules

**On conflict:** keep the fork's values. Take upstream's structural changes to
the build script and re-apply the identity constants on top.

### Claude account sign-in from the Limits view

Repairs an expired Claude credential without a terminal. Upstream reports the
broken account but offers no way to fix it.

- `apps/server/src/limits/ProviderLoginService.ts` and its test
- `apps/server/src/provider/ClaudeProvider.ts`: `claudeAuthMetadata` labels an
  install that authenticates with an API key as "Claude API Key", which upstream
  leaves unlabelled; one test in the provider-registry test covers it
- the instance-registry test, whose Claude fixture
  (`provider/testing/ProviderInstanceRegistryLive.fixture.mjs`) reports signed out
  when a sibling `claude-account-state` file says so
- `packages/contracts/src/limits.ts` (sign-in contracts only) and the two
  `server.*ProviderLogin` RPCs. Like every fork RPC they are registered in three
  upstream tables: a scope in `RpcAuthorization.ts` (`providers:manage`, as for
  upstream's provider-auth RPCs), a handler in `ws.ts`, and a label in
  `RpcInstrumentation.ts`
- `apps/web/src/components/usage/ProviderLoginDialog.tsx`,
  `claudeSignIn.ts` and `ClaudeSignIns.tsx`, plus one line rendering
  `<ClaudeSignIns />` in upstream's `UsageLimitsPooled.tsx`

Upstream has in-app authentication for Antigravity, Codex ChatGPT, and ACP
Registry providers, but Claude has no native auth controller. Upstream reports a broken account
through `collectLimitNotices`, which returns plain strings with no provider
identity, and drops an account whose probe reported nothing at all — which is
exactly what an unusable credential looks like. The fork collects those accounts
separately rather than widening that function, so upstream's notices and their
tests stay untouched. The signed-out state itself is upstream's
`claudeAuthStatus`: a CLI reporting token source `none` with no account identity
is unauthenticated. After a sign-in the client refreshes that instance with
`refreshModels`, which is upstream's way to drop its cached capabilities.

**On conflict:** the collection is fork-owned, while the render line and the
API-key label sit in upstream-owned files. Re-apply them as the smallest patches.
Retire the whole thing once upstream offers an equivalent Claude sign-in flow.
Upstream's generic `ProviderAuthFlow` helper has production callers in
`CodexChatGptAuth.ts` and the ACP Registry's `auth.ts`. A Claude controller built
on that infrastructure would replace `ProviderLoginService`.

### Claude multi-account support

Switch between Claude accounts in the same thread while preserving the provider
session. Each account remains a separate provider instance with its own
`CLAUDE_CONFIG_DIR`. Accounts can share a transcript tree or keep separate ones.

- `apps/server/src/provider/Drivers/ClaudeHome.ts` keys session continuation on the
  resolved `projects` path, so accounts sharing a transcript tree share continuation.
  Upstream keys on the home directory instead. The function keeps upstream's
  optional environment argument so an inherited `CLAUDE_CONFIG_DIR` resolves the
  same way; upstream's tests for that key are rewritten to the fork's format.

- `ProviderSessionTransitionPolicy.ts` also permits native continuation between
  Claude accounts with different `claude:projects:` keys.
- `provider/Drivers/ClaudeSessionHistory.ts` copies the complete native session
  transcript and its auxiliary directory into the destination account's projects
  tree. `ProviderTurnStartService.ts` transfers from the last account that
  actually ran that native conversation, then resumes the same native ID.
  Transfers preserve unrelated sessions and atomically publish the transcript.
  A missing or unreadable source fails the switch instead of sending a portable
  handoff. Switching back copies the updated native history back in full.
- `Orchestrator.ts` plans a queued run's switch from the active provider
  thread's instance whenever they differ. Upstream does this only for monitor
  updates (`followsCurrentConversation`), so a message queued after the picker
  moved to another account would skip the native transfer. The fork drops that
  condition from `switchFromActiveProvider`.
- `ClaudeAdapterV2.ts`'s query runner looks up subagent transcripts through
  upstream's Claude history worker (`claudeHistoryWorker.ts`, the
  `getSubagentMessages` method) when the instance's `CLAUDE_CONFIG_DIR` differs
  from the server's. Upstream already forks sessions that way but still reads
  subagent transcripts in-process, which finds nothing for an account with its
  own `homePath`. Drop this once upstream routes that lookup through the worker.

Sharing a transcript tree through symlinks avoids copying. Distinct directories
are supported without changing their links or account credentials. Claude ↔
Codex switches still use upstream's portable handoff.

**On conflict:** preserve full native continuation across Claude account config
directories. Retire the transfer only when upstream supports equivalent history
preservation; provider-name equality alone is insufficient without making the
native transcript available to the destination account.

Upstream now scans every configured Claude, Codex, and Grok instance for usage
history and collapses aliased homes. That behavior is no longer fork-owned.

### Composer: warning when the thread's account is nearly spent

Upstream offers Usage → Limits and a recovery banner after a usage-limit failure,
but no proactive warning before exhaustion. This warns in the thread at 95% of
a session or weekly window.

- `apps/web/src/components/usage/limitWarning.ts` and its test
- `apps/web/src/components/usage/useLimitWarningBanner.tsx` builds the banner
- `apps/web/src/components/ChatView.tsx`: calls the hook and stacks the banner
  first in `composerBannerItems`

The web/desktop warning follows the composer's selected account and model.
Model-specific windows only warn for that model; shared windows always apply.
Antigravity buckets are matched by family: Gemini models read the Gemini
buckets, everything else the shared Claude and GPT ones.
The banner names other accounts with quota, ranked by their tightest applicable
window, or says when every reported account is exhausted. Missing or failed
reads remain unknown, and a passed reset needs fresh data before it counts as
available. Comparisons use providers and hubs in the thread's environment.
Reads the existing config stream without extra requests. Dismissals lapse on
rollover and when usage reaches 100%.

**On conflict:** retain model filtering and account availability on top of an
upstream warning if it lacks them; compare before retiring this implementation.

### Model picker: remaining quota

Web, desktop, and mobile model rows show remaining weekly quota. Fable uses its
own bucket; other Claude models use the shared weekly allowance. Claude account
selectors show session quota separately. Codex model rows show weekly quota,
with no session figure in the account selector. Low balances use warning text;
expired or failed readings with an existing quota window show an unknown balance
until refreshed. Missing or unsupported windows show no quota label.

The picker uses the environment's existing provider snapshots, including in
Settings and new-thread pickers. Selection and formatting live in
`packages/shared/src/modelPickerQuota.ts` so clients agree. On mobile the
quota text and the `quota` row prop live in upstream's
`ThreadSettingsRows.shared.tsx`, since upstream moved the rows out of the sheet.

**On conflict:** compare quota selection and account placement before replacing
this with upstream's picker. Retire the helper when upstream covers both clients.

### New threads: pick the account by usage limits

A new thread on web, desktop, or mobile moves its default selection (project
default, carried selection, or sticky last pick) to the same-driver account with
the best usable limits for that model, keeping the model and options. An explicit
composer pick wins, and the auto pick is never written as the sticky selection.
Agent-created threads, scheduled tasks, and existing threads are unchanged.
Upstream always starts on the default account.

- `packages/shared/src/providerAccountPick.ts` and its test: the ranking heuristic,
  plus the model-scope helpers and 95% threshold the composer warning now imports
- `packages/client-runtime/src/newThreadAccount.ts` and its test: candidate
  filtering (same driver, enabled for the project, available, signed in, has the model)
- `apps/web/src/lib/newThreadAccount.ts`, called after the defaults in
  `hooks/useHandleNewThread.ts` and `components/chat/DraftHeroHeadline.tsx`
- `apps/mobile/src/features/threads/new-task-flow-provider.tsx`: derives
  `selectedModel` through the same helper when the draft has no explicit pick
- `autoPickProviderAccount` server setting (default on) in `packages/contracts/src/settings.ts`;
  the toggle is `AutoPickProviderAccountRow` in Settings → Providers → Advanced, with a
  settings-search entry. Mobile has no toggle; it follows the server setting.

**On conflict:** keep the call after upstream's default resolution in each
new-thread path. If upstream adds account selection for new threads, compare its
ranking with this one and ask before retiring either.

### Limits bars: per-instance colour and short names

Upstream paints every account in a pool with one hardcoded driver colour and
prints the full instance name on each bar, so four Claude accounts look alike
and each row repeats the heading's own word.

- `apps/web/src/components/usage/accountName.ts` and its test
- `apps/web/src/components/usage/UsageLimitsPooled.tsx`: `segmentColor` from
  `account.accentColor`, and the `shortAccountName` call in `AccountName`

The accent colour already reaches the client on `UsageLimitsReport`; upstream
only uses it for the avatar. Popover titles and aria-labels keep the full name,
which is read without the heading for context.

### Pull request assignees (GitHub)

An **Assignees** row under Reviewers on the pull request summary: who is assigned,
and a menu to assign or unassign anyone GitHub counts assignable. Upstream reads and
changes reviewers and labels but not assignees.

It follows upstream's label feature layer for layer: an optional `assignees`
capability and viewer permission (triage access), an optional `assignees` list on
`PullRequestDetail`, two RPCs (`pullRequests.assigneeCandidates`,
`pullRequests.setAssignees`), optional provider methods, and a cache update in
`client-runtime`. The GraphQL side is an `assignees` selection on upstream's
`PullRequestCore` and an `AssigneeCandidates` query, both in
`pullRequestReads.graphql`; regenerate `pullRequestReads.graphql.ts` with
`vp run generate` in that package after a conflict there. `setAssignees` needs `source-control:write`, declared beside
`setLabels` in `clientRpcPermissions.ts`, and a session without it sees the
menu disabled like the label menu (`usePullRequestDetail.ts`). Only the GitHub provider implements it; assignees ride upstream's
core GraphQL detail query, so the detail costs no extra request. The UI lives in the
fork-owned `PullRequestAssignees.tsx`; `PullRequestSummaryTab.tsx` only mounts it.
There is no mobile assignee UI or agent MCP tool. GitHub can return success
without applying an assignment; preserve the API's check of the returned assignees.

**On conflict:** the edits to upstream files are additions next to the label code, so
keep both sides. If upstream ships assignees, take theirs and delete this.

### Chat: stop-hook follow-ups

A Claude stop hook appends a self-check reply after the real final response, in
the same turn. Upstream treats the last assistant message of a turn as its answer
and folds everything before it under "Worked for ...", which hides the final
response. The fork marks the hook and leaves such turns unfolded:

- `ClaudeAdapterV2.ts`: `isClaudeStopHookFeedback` turns the SDK's synthetic
  `Stop hook feedback:` frame into a `Stop hook feedback` system notice. A
  `/goal` evaluator check arrives the same way and is skipped, since upstream
  tracks it as goal progress.
- `MessagesTimeline.logic.ts` (web) and `threadActivity.ts` (mobile): a run with
  that notice does not fold. Web also keeps the older `Self-check` reply-text
  match for turns recorded before the notice existed.

Do not rely on the reply text alone: Claude does not always open its follow-up
with "Self-check", and turns that didn't were folded.

**On conflict:** keep the adapter notice and both fold checks, with their tests
("marks Stop hook feedback between the answer and its follow-up", "keeps turns
with a stop-hook self-check fully expanded", "keeps a response with a Claude
stop-hook follow-up unfolded"). Retire them only once those fold tests pass on
upstream's code without the fork's checks.

### Chat: fork from a user message

Upstream forks only after an assistant response. A **Fork from here** button on
a user message forks after the run before it and leaves the message's text in
the new thread's composer, to resend or edit it. It rides upstream's
`thread.fork`; nothing server-side is fork-owned.

- `apps/web/src/components/chat/userMessageFork.ts` and its test map each run's
  starting message to the forkable run before it
- `TimelineUserMessageRow.tsx`: `ForkUserMessageButton`; `MessagesTimeline.tsx`
  and `timelineRowContext.ts`: the `userMessageForkSources` prop and an optional
  `prompt` on upstream's `onForkFromRun`
- `ChatView.tsx` computes the sources from the projection's runs;
  `useTimelineRewind.ts` sets the forked thread's draft before navigating

A thread's first message has no run before it, so it gets no button. A message
sent after a completed `/compact` run forks before that run, because Claude
records no reply there to fork at.
The restored draft contains message text with context-reference labels;
attachments and structured context references are not copied.

**On conflict:** keep the button beside upstream's fork-from-response. Retire it
if upstream adds forking before a user message.

### File picker: open an absolute path

Upstream's file picker (`filePicker.toggle`) only searches the active project's
index. Typing or pasting an absolute path offers that path as the single result,
which opens it in the read-only host-file preview upstream already uses for
absolute chat links, from any project.

- `ProjectFilePicker.logic.ts`: `hostFilePathFromQuery` and its test
- `ProjectFilePicker.tsx`: the `host-file` result group; the index search runs
  with an empty query while the input holds an absolute path

**On conflict:** re-apply the result group on upstream's picker. Retire it if
upstream's picker opens absolute paths.

### Composer: compacting a stale Claude thread is opt-in

Upstream's Compact chip (shown after Claude's prompt cache expires on a 100k+
token thread) is on by default, so Enter and the send button run `/compact`
before the message. Taufeeque wants a normal send by default. The chip is a
one-click "compact, then send" button instead of a toggle; Enter and the send
button always keep full history.

- `ComposerPrimaryActions.tsx`: the chip calls `onCompactAndSendMessage`; the
  send button no longer changes label or tooltip for compaction
- `ChatComposer.tsx`: `handleCompactAndSendMessage` passes `compactFirst`
  through `submitComposer` to `onSend`, via `ComposerFooterControls.tsx`; the
  mobile collapsed send button sends
- `useComposerSend.ts`: `onSend` takes `compactFirst` and hands it to
  `planComposerTurn` (`ChatView.logic.ts`); `ChatView.tsx` no longer keeps the
  per-thread full-history toggle state
- `docs/user/providers-claude.md`: the chip's description

**On conflict:** keep upstream's offer conditions (`shouldOfferResumeCompaction`)
and re-apply the opt-in wiring. Retire it if upstream makes plain send the
default.

### Temporary worktree branches use the branch-name prefix

Upstream names worktree branches `t3/<hex>` and only applies the
`branchNamePrefix` setting when the background rename lands, so a failed
rename leaves a `t3/` branch. The fork names temporary branches under the same
prefix (`tf-c/<hex>`), still recognising upstream's `t3` and legacy shapes.

- `packages/shared/src/git.ts`: optional `branchNamePrefix` on
  `buildTemporaryWorktreeBranchName`, `flattenTemporaryWorktreeBranchName`, and
  `isTemporaryWorktreeBranch`, plus `temporaryWorktreeBranchPrefix`
- `apps/server/src/orchestration-v2/ThreadLaunchService.ts` passes the project's
  `branchNamePrefix`
- `docs/user/project-settings.md`: one sentence under "Worktree branch names"

Mobile still sends `t3/<hex>` names, which the server recognises and renames.

**On conflict:** re-apply the optional parameter. Retire it once upstream
names temporary branches from its prefix setting.

### Database migration ledger

The retired sidebar search left migration ID 50, `ProjectionThreadSearchUnits`,
in installed databases. Keep that migration and its unused table. Upstream's
migrations from ID 50 onward run one ID later here (`OrchestrationV2` is 56).
Preserve every released ID/name pair in `Migrations.ts`; renumbering would make
a later schema change look already applied. `FIRST_V2_MIGRATION_ID` is 56 for the same reason, and
`Migrations.test.ts` names IDs one higher than upstream's copy. Append incoming upstream migrations
at the next free fork ID and adjust tests that name migration IDs, including
the dev-database migration test.

`reconcileV2PreviewMigration` only matches an `OrchestrationV2` row at 53 or 54,
which the fork's ledger does not use. Its upstream fixture test is removed;
the reconciliation implementation remains upstream-owned.

**On conflict:** preserve the fork's ledger while taking upstream's migration
implementations. Retiring a feature does not retire its applied migration.

### Packaged backend ships zod for @cursor/sdk

`@cursor/sdk` 1.0.38 moved `zod` from a dependency to a peer dependency. The
desktop stage installs only the externals `apps/server/package.json` declares,
so the 0.1.3 build shipped without `zod` and the backend exited on
`Cannot find module 'zod/v4'`, leaving no window. The bundle self-check that
would catch this (`bin.mjs --version`) runs only for Windows sidecar builds.

- `apps/server/package.json` declares `zod`; `knip.jsonc` ignores it as unused.

**On conflict:** take upstream's fix if it lands. Retire this once upstream
declares `zod` for the server or `@cursor/sdk` lists it as a dependency again.

### Monthly spend amounts

`claudeUsageLimits.ts` labels upstream's "Monthly spend" window with the amounts
it already reads, such as "Monthly spend · $46.31 of $500", so every client that
shows a window label shows the spend without a contract change.

**On conflict:** keep upstream's parsing and re-apply the label. Retire this
once upstream shows the amounts itself.

### Pull requests from forks and submodules

Upstream lists one repository per project, the canonical one (`upstream`, else
`origin`). A fork checkout then lists the original project's pull requests
instead of the fork's, and a submodule's pull requests never show. The fork
lists the fork (`RepositoryIdentity.origin`, which is itself fork-owned) in
place of the canonical repository, and adds one entry per initialized direct
submodule. Project grouping still uses the canonical identity.

- `RepositoryIdentityResolver.ts`: `changeRequestRepositoryIdentity` rebuilds
  an identity on its `origin` remote; `resolveSubmodules` reads the top-level
  `.gitmodules` and keeps paths whose own checkout lies below the project's.
  Test stubs of the resolver use `Layer.mock` so the extra method needs no stub.
- `PullRequestService.ts`: `repositoryCheckouts` expands each project into its
  checkouts before `resolveRemoteHosts`. Each `SupportedProject.project` is the
  project shell with that checkout's `workspaceRoot` and identity, so every
  provider call and `detail.workspaceRoot` already run in the submodule.
  `requireProject` picks the project's entry for the requested repository
  rather than `supported[0]`, and its host fallback prefers the requested
  project, so a fork project's canonical pull requests stay on it. `listStats`
  keys by repository. `checkout` exposes the shell to the review guide.
- `PullRequestReviewGuideService.ts`: writes from `checkout`'s directory and
  accepts the checkout's identity or, at the project root, the canonical one.
- Web `PullRequestDetailPanel.tsx`: a submodule pull request checks out in
  `detail.workspaceRoot`, offers no other environment, and a local checkout
  leaves the thread's branch alone. `pullRequestProjectAssignment.logic.ts` and
  mobile `pullRequestEnvironmentFallback.ts` match projects by the fork key.
  Mobile `usePullRequestThreads.ts` refuses to start work on a submodule's pull
  request, because its outbox checks out in the project root.

**On conflict:** keep upstream's listing and re-apply `repositoryCheckouts`,
the `requireProject` lookup, and the shell override. If upstream lists forks or
submodules itself, compare and ask which to keep.

### Desktop: secondary windows

Upstream's desktop app has one window. The fork opens more, so two threads can
be watched side by side: File → New Window (`CmdOrCtrl+Alt+Shift+N`, since
`mod+shift+n` is `chat.newLocal`) duplicates the focused window's route, and the
thread context menu's "Open in new window" opens that thread.

- `DesktopWindow.ts`: `openWindow` calls `createWindow` with a route. A
  secondary window cascades from the focused one, loads `#<route>`, skips
  saved bounds and `previewManager.setMainWindow`, and refuses webviews.
  `zoomMain` and `runMainContentsCommand` act on `ElectronWindow.focusedApp`.
- `ElectronWindow.ts`: `addSecondary`, `focusedApp` and `appWindowFor` track app
  windows apart from popups, and `currentMainOrFirst` skips secondaries so a
  closed main is recreated (Dock click or New Window) instead of a secondary
  standing in for it. `ipc/methods/window.ts` uses `appWindowFor` for
  `pasteAsText`, `revealWindow`, `showContextMenu` and the new `openWindow`.
- `preload.ts`: a secondary window (`SECONDARY_WINDOW_ARGUMENT`) gets the bridge
  without `preview`, `webLinks` and `appActivation`, which the main process ties
  to the main window, and with `secondaryWindow: true`. The web then treats it
  like a browser client: the panel uses the server browser.
- Web: `ElectronBrowserHost`, `rendersServerTabNatively` and
  `useDesktopHostedPreviewSessions` check `isPreviewSupportedInRuntime()`
  instead of `isElectron`; a tab main hosts shows upstream's "open in the
  desktop app" placeholder. In secondary windows `ThreadNotificationCoordinator`
  reads the notification mode as `"off"` (in-app toasts only),
  `setNotificationBadge` is a no-op, and guide notifications do not start, so
  sound, OS alerts and the dock badge come from main alone.
  `scripts/verify-preload-bundle.mjs` stubs `process.argv` for the preload.

**On conflict:** keep the `isSecondary` branches in `createWindow` and the
preload split. If upstream adds multi-window support, compare and ask which to
keep.

## Retired: superseded by upstream

### Native conversation forks, end-of-turn queue, worktree prefix setting

Retired on 2026-10-06 when upstream replaced its orchestrator with V2 (#2829),
deleting the V1 code all three were built on.

- Forks: V2's `thread.fork` forks from any completed assistant response, natively
  on Claude, Codex, OpenCode, and Pi. Other providers follow their advertised
  capabilities, with portable context as fallback; ACP can also fork at the
  current native head when its runtime supports it. The
  fork's sidebar "Fork thread" entry and forking a running thread went with it;
  forking from a user message was re-ported on V2 (above).
- Queue: V2 queues follow-ups on the server and starts the next one only when
  the active run ends, which is the rule the fork carried.
- The `worktreeBranchPrefix` setting gave way to upstream's `branchNamePrefix`;
  only the temporary-branch patch above survives.

### Claude extra usage credits

Retired on 2026-10-25 when upstream began reading `rate_limits.spend` and
`rate_limits.extra_usage` into a "Monthly spend" window on the account's bar.
Upstream shows the percentage only; the fork keeps the amounts in that window's
label (see "Monthly spend amounts").

### Fuzzy sidebar search over thread contents

Retired on 2026-09-22 after upstream fed its thread search into the sidebar
(#11761): a substring scan over user and assistant messages across connected
environments, with a highlighted excerpt under each row. The fork's fuzzy,
per-unit search let too many threads through to be useful, so the parallel
service, RPC, shared matcher, and client state were deleted and the sidebar is
upstream's again.

The migration remains fork-owned; see Database migration ledger above.

### Claude thinking in conversation history

Retired on 2026-09-18 when upstream shipped provider thinking traces across
Claude, Cursor, and Grok with web/mobile rendering, snapshot-only backfill,
partial-stream completion, and subagent filtering. The fork's parallel activity
model also supported late correction of a completed Claude snapshot, but keeping
two reasoning projections for that rare case was not worth the duplication.

### Provider limits view

Removed on 2026-09-05 when upstream shipped its own limits view. Do not revive.

- `apps/server/src/limits/ProviderLimitsService.ts` → upstream's
  `providerUsageLimits.ts` / `codexUsageLimits.ts`, which also report Codex reset
  credits and support redeeming them
- `apps/web/src/components/limits/*`, `routes/limits.tsx`, `state/limits.ts`,
  `docs/user/limits.md` → upstream's **Usage → Limits** (`UsageLimits.tsx`), which
  additionally covers mobile and CLIProxyAPI hubs
- `server.getProviderLimits` RPC and its contracts

What survived the retirement: the sign-in flow above, and a `metric` search param
on the usage route so the sidebar's Limits entry opens that view in one click
(`apps/web/src/routes/_chat.usage.tsx`, `SidebarChrome.tsx`). Upstream later added a
stored metric preference; the route prop overrides it while the search param is
present, so a deep link still wins and an ordinary visit resumes the last view.

On 2026-09-07 upstream replaced the per-provider list with the pooled view
(`UsageLimitsPooled.tsx`), deleting the `ProviderLimits` component the fork's
sign-in button and extra-usage bar lived in. Both were re-homed onto the pooled
view rather than kept as a parallel one.
