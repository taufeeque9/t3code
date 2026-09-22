# Custom fork inventory

Everything this fork carries on top of `pingdotgg/t3code@main`, so an upstream
merge can tell fork work from upstream work without reading history. Update this
file in the same commit that adds, changes, or retires a fork feature.

Regenerate the raw picture with:

```bash
git diff --name-only upstream/main custom | grep -v '^\.repos/'
git log --oneline --no-merges upstream/main..custom
```

Each entry records why the fork carries it and what a future merge should do
when upstream moves into the same area. See the conflict rule in `AGENTS.md`.

## Keep: no upstream equivalent

### Custom desktop build and self-updater

The reason the fork exists: an independently branded, self-installing build.

- `apps/desktop/package.json` (`productName`), `apps/desktop/src/app/DesktopEnvironment.ts`
  (app base name, `appUserModelId`)
- `scripts/build-desktop-artifact.ts` (`appId`, artifact name, URL schemes) and its test
- `scripts/custom/update-installed-app.sh` and its test. Its dirty-tree guard
  checks tracked changes only: the desktop build emits `.d.ts` beside its
  sources, and counting untracked files let the updater's own output block
  every later run until the checkout was cleaned by hand.
- `.gitignore` ignores those generated `scripts/lib/*.d.ts`
- `.github/workflows/custom-ci.yml`, `.github/workflows/custom-upstream-sync.yml`
- `.github/workflows/ci.yml` restricts upstream's CI to `main` so fork branches do not run it

**On conflict:** keep the fork's values. Take upstream's structural changes to
the build script and re-apply the identity constants on top.

### Native conversation forks

Forking a thread into a new one that resumes the provider session at a chosen
message. Upstream has no equivalent.

- `apps/server/src/orchestration/threadFork.ts`, the `thread.fork` case in `decider.ts`,
  `ProviderCommandReactor.ts`
- `apps/server/src/provider/Services/ProviderService.ts` + `ProviderAdapter.ts`
  (`prepareSessionFork`), `ClaudeAdapter.ts`, `CodexAdapter.ts`, `CodexSessionRuntime.ts`
- `packages/contracts`: `ThreadForkInput/Result/Error`, `ProviderSessionForkPoint`,
  `serverForkThread`, the `threadForking` capability
- `apps/web`: `hooks/useForkThread.ts`, plus fork entry points in `ChatView.tsx`,
  `Sidebar.tsx`, `MessagesTimeline.tsx`, `threadActionMenu.logic.ts`

### Claude account sign-in from the Limits view

Repairs an expired Claude credential without a terminal. Upstream reports the
broken account but offers no way to fix it.

- `apps/server/src/limits/ProviderLoginService.ts` and its test
- `apps/server/src/provider/Layers/ClaudeProvider.ts` and its provider-registry test
- `apps/server/src/provider/Drivers/ClaudeDriver.ts` and its instance-registry test
- `packages/contracts/src/limits.ts` (sign-in contracts only), the two
  `server.*ProviderLogin` RPCs, their `ws.ts` handlers and auth scopes
- `apps/web/src/components/usage/ProviderLoginDialog.tsx`,
  `claudeSignIn.ts` and `ClaudeSignIns.tsx`, plus one line rendering
  `<ClaudeSignIns />` in upstream's `UsageLimitsPooled.tsx`

Upstream's only in-app provider sign-in is Antigravity's Google flow
(`ProviderSetupSection.tsx`); Claude has none. Upstream reports a broken account
through `collectLimitNotices`, which returns plain strings with no provider
identity, and drops an account whose probe reported nothing at all — which is
exactly what an unusable credential looks like. The fork collects those accounts
separately rather than widening that function, so upstream's notices and their
tests stay untouched. It also treats an SDK initialization with no account
identity as signed out; otherwise Claude reports the expired login as a working
account with unsupported limits and the repair action disappears after refresh.
Explicit provider refreshes invalidate Claude's short-lived capability cache so
the refresh following a successful sign-in observes the new credential immediately.

**On conflict:** the collection is fork-owned, while the render line and the two
server status/cache patches sit in upstream-owned files. Re-apply the smallest
patches until upstream both recognizes expired Claude authentication and refreshes
capabilities immediately after sign-in. Retire the whole thing once upstream
offers an equivalent Claude sign-in flow.

### Claude multi-account support

Switch between Claude accounts in the same thread while preserving the provider
session. Each account remains a separate provider instance with its own
`CLAUDE_CONFIG_DIR`, while compatible accounts can share one transcript tree.

- `apps/server/src/provider/Drivers/ClaudeHome.ts` keys session continuation on the
  resolved `projects` path, so accounts sharing a transcript tree share continuation.
  Upstream keys on the home directory instead. The function keeps upstream's
  optional environment argument so an inherited `CLAUDE_CONFIG_DIR` resolves the
  same way; upstream's tests for that key are rewritten to the fork's format.
- `apps/server/src/provider/Layers/ProviderService.ts` allows switching instances
  within a provider when continuation identity matches (`reusePersistedState`)

Upstream now scans every configured Claude, Codex, and Grok instance for usage
history and collapses aliased homes. That behavior is no longer fork-owned.

### Claude extra usage credits

Upstream's Claude limits parser ignores `rate_limits.extra_usage`, so accounts on
pay-as-you-go credits (the FAR account) see no credit balance. The fork adds the
smallest edit on top of upstream's pipeline rather than a parallel view.

- `packages/contracts/src/providerUsageLimits.ts`: `ServerProviderExtraUsage`,
  optional `extraUsage` on `ServerProviderUsageLimits`
- `apps/server/src/provider/Layers/claudeUsageLimits.ts`: `claudeExtraUsage`
- `apps/web/src/components/usage/extraUsage.ts`, shown as an `Extra` row in the
  account popover of upstream's `UsageLimitsPooled.tsx`

**On conflict:** drop all of it the moment upstream reports extra usage itself.

### Composer: warning when the thread's account is nearly spent

Upstream shows limits only when asked (`/limits`), so a turn can be refused
with no warning. This warns in the thread at 95% of a session or weekly window.

- `apps/web/src/components/usage/limitWarning.ts` and its test
- `apps/web/src/components/ChatView.tsx`: the `limitWarning` memo and its banner

The web/desktop warning follows the composer's selected account and model.
Model-specific windows only warn for that model; shared windows always apply.
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
expired or failed readings show an unknown balance until refreshed.

The picker uses the environment's existing provider snapshots, including in
Settings and new-thread pickers. Selection and formatting live in
`packages/shared/src/modelPickerQuota.ts` so clients agree. On mobile the
quota text and the `quota` row prop live in upstream's
`ThreadSettingsRows.shared.tsx`, since upstream moved the rows out of the sheet.

**On conflict:** compare quota selection and account placement before replacing
this with upstream's picker. Retire the helper when upstream covers both clients.

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

### Fuzzy sidebar search over thread contents

The sidebar matched thread titles only, among threads it had already loaded.
Upstream's `orchestration.searchThreads` is an exact substring scan over whole
messages, is not scoped to a project, and backs the command palette rather than
the sidebar. It is left untouched; the fork adds a parallel path.

- `apps/server/src/persistence/Migrations/050_ProjectionThreadSearchUnits.ts`
- `Migrations.ts` keeps the shipped search migration at ID 50. Upstream's
  `050_ProjectionThreadPullRequests.ts` runs at ID 51 in this fork; its upgrade
  tests start from the existing search database. Upstream migrations 51–53
  consequently run at IDs 52–54. Keep these IDs stable and assign future
  migrations unused IDs when upstream numbering overlaps.
- `apps/server/src/orchestration/Layers/threadSearchIndex.ts` and its test —
  its own service, not a method on `ProjectionSnapshotQuery`, whose shape a
  dozen upstream tests stub
- `packages/shared/src/fuzzyMatch.ts`, `threadSearchUnits.ts` and their tests
- `packages/contracts`: `orchestration.searchThreadUnits` and its schemas, the
  RPC in `rpc.ts`, the scope in `RpcAuthorization.ts`, the `ws.ts` handler
- `packages/client-runtime/src/state/threadUnitSearch.ts`
- `apps/web`: `useThreadUnitSearch` in `state/queries.ts`, and in `Sidebar.tsx`
  both the merge with the title match and `SidebarSearchResultRow`'s second
  line, which shows the matched text so a filtered list says why each row is in
  it. Title hits stay one line.

One row per unit — title, URL, user message — is what bounds fuzzy matching to
a single unit, so a loose query cannot stitch two messages together. Units are
derived and re-extracted when a thread's `updated_at` passes its watermark, so
no projection write path is fork-owned.

Since 2026-09 upstream also feeds its exact `searchThreads` into the sidebar
(`useThreadSearch`, `ThreadSearchMatchExcerpt`, a `contentMatchKeys` argument
on `searchSidebarThreads`). That search is a substring scan over user and
assistant messages across every connected environment, and its excerpt
highlights the literal query. The fork's sidebar does not mount it: the row
and the result list keep the fuzzy, project-scoped path above, and upstream's
components stay in the tree for the command palette. Which of the two the
sidebar should use is Taufeeque's call and has not been made yet.

**On conflict:** the fork touches upstream files only at the registration
points listed above. Retire it if upstream ever makes its own search fuzzy and
project-scoped.

### Composer: end-of-turn queue semantics

Upstream owns the multi-message queue, full draft snapshots (attachments and
contexts), inline controls, and the queue-versus-steer setting. The fork keeps
two behavior refinements:

- automatic delivery waits until the active turn finishes; **Send now** remains
  the explicit way to steer during a turn;
- each queued draft captures its model, runtime mode, interaction mode, and
  prompt effort instead of inheriting whatever the composer selects later.

`queuedMessageStore.ts` and its test own the timing rule and captured settings;
`ChatView.tsx` records and replays them. `Sidebar.tsx`, `LegacySidebar.tsx`, and
`Sidebar.logic.ts` keep threads with queued work visible as active.

The old fork queue, its reload persistence, root-level coordinator, and dedicated
keybinding were retired when upstream's richer queue landed. Full drafts contain
live attachment uploads, so persisting or dispatching them outside `ChatView`
would risk replaying stale files.

**On conflict:** retire these refinements when upstream waits for turn completion
and snapshots the queued draft's provider settings.

### Pull request assignees (GitHub)

An **Assignees** row under Reviewers on the pull request summary: who is assigned,
and a menu to assign or unassign anyone GitHub counts assignable. Upstream reads and
changes reviewers and labels but not assignees.

It follows upstream's label feature layer for layer: an optional `assignees`
capability and viewer permission (triage access), an optional `assignees` list on
`PullRequestDetail`, two RPCs (`pullRequests.assigneeCandidates`,
`pullRequests.setAssignees`), optional provider methods, and a cache update in
`client-runtime`. Only the GitHub provider implements it; assignees ride upstream's
core GraphQL detail query, so the detail costs no extra request. The UI lives in the
fork-owned `PullRequestAssignees.tsx`; `PullRequestSummaryTab.tsx` only mounts it.

**On conflict:** the edits to upstream files are additions next to the label code, so
keep both sides. If upstream ships assignees, take theirs and delete this.

## Reassess on the next upstream change

### Configurable worktree branch prefix

Upstream hardcodes the `t3code` prefix; the fork makes it a server setting. Worth
keeping only while the setting is actually used.

- `packages/contracts/src/settings.ts` (`WorktreeBranchPrefix`,
  `DEFAULT_WORKTREE_BRANCH_PREFIX`), `packages/shared/src/git.ts`
- `apps/web`: `SettingsPanels.tsx`, `GitActionsControl`, `ChatView.tsx`
- `apps/mobile`: `projectThreadStartTurn.ts`, `use-thread-outbox-drain.ts`.
  Upstream moved thread creation onto the outbox (#10435) and deleted
  `use-project-actions.ts`, so the setting now reaches the server through the
  drain alone and `NewTaskDraftScreen.tsx` is upstream's again.
- `apps/server`: `CheckpointReactor.ts`, `ProviderCommandReactor.ts`

This one touches the most files of any fork feature and conflicts on most merges.

## Retired: superseded by upstream

### Claude thinking in conversation history

Retired on 2026-09-18 when upstream shipped provider thinking traces across
Claude, Cursor, and Grok with web/mobile rendering, snapshot-only backfill,
partial-stream completion, and subagent filtering. The fork's parallel activity
model also supported late correction of a completed Claude snapshot, but keeping
two reasoning projections for that rare case was not worth the duplication.

### Chat stop-hook follow-ups

Retired on 2026-09-18 because upstream now keeps stop-hook warnings and their
self-check replies outside the preceding turn fold with equivalent behavior.

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
(`apps/web/src/routes/usage.tsx`, `SidebarChrome.tsx`). Upstream later added a
stored metric preference; the route prop overrides it while the search param is
present, so a deep link still wins and an ordinary visit resumes the last view.

On 2026-09-07 upstream replaced the per-provider list with the pooled view
(`UsageLimitsPooled.tsx`), deleting the `ProviderLimits` component the fork's
sign-in button and extra-usage bar lived in. Both were re-homed onto the pooled
view rather than kept as a parallel one.
