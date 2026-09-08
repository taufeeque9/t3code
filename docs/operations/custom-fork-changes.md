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
- `scripts/custom/update-installed-app.sh` and its test
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
tests stay untouched.

**On conflict:** the collection is fork-owned; only the one render line sits in
an upstream file. Re-apply that line wherever upstream's limits view puts its
notices. Retire the whole thing if upstream ever offers a Claude sign-in.

### Claude multi-account support

Several Claude accounts as separate provider instances, each with its own
`CLAUDE_CONFIG_DIR`.

- `apps/server/src/provider/Drivers/ClaudeHome.ts` keys session continuation on the
  resolved `projects` path, so accounts sharing a transcript tree share continuation.
  Upstream keys on the home directory instead.
- `apps/server/src/provider/Layers/ProviderService.ts` allows switching instances
  within a provider when continuation identity matches (`reusePersistedState`)
- `apps/server/src/usage/UsageService.ts` scans every configured Claude instance home
  and collapses symlinked duplicates. Upstream still scans only
  `providers.claudeAgent`.

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

### Fuzzy sidebar search over thread contents

The sidebar matched thread titles only, among threads it had already loaded.
Upstream's `orchestration.searchThreads` is an exact substring scan over whole
messages, is not scoped to a project, and backs the command palette rather than
the sidebar. It is left untouched; the fork adds a parallel path.

- `apps/server/src/persistence/Migrations/050_ProjectionThreadSearchUnits.ts`
- `apps/server/src/orchestration/Layers/threadSearchIndex.ts` and its test —
  its own service, not a method on `ProjectionSnapshotQuery`, whose shape a
  dozen upstream tests stub
- `packages/shared/src/fuzzyMatch.ts`, `threadSearchUnits.ts` and their tests
- `packages/contracts`: `orchestration.searchThreadUnits` and its schemas, the
  RPC in `rpc.ts`, the scope in `RpcAuthorization.ts`, the `ws.ts` handler
- `packages/client-runtime/src/state/threadUnitSearch.ts`
- `apps/web`: `useThreadUnitSearch` in `state/queries.ts`, and the merge with
  the title match in `Sidebar.tsx`

One row per unit — title, URL, user message — is what bounds fuzzy matching to
a single unit, so a loose query cannot stitch two messages together. Units are
derived and re-extracted when a thread's `updated_at` passes its watermark, so
no projection write path is fork-owned.

**On conflict:** the fork touches upstream files only at the registration
points listed above. Retire it if upstream ever makes its own search fuzzy and
project-scoped.

### Composer: queue a message for the end of the turn

Sending mid-turn interrupts the agent, and upstream offers no way to hold a
message back. Client-side and web-only by choice: a server-side queued turn
would work across surfaces but is a much larger orchestration change.

- `apps/web/src/queuedMessageStore.ts` and its test
- `apps/web/src/components/ChatView.tsx`: `queueCurrentPrompt`,
  `editQueuedMessage`, the auto-send effect, the banner, the shortcut case
- `packages/contracts/src/keybindings.ts` (`composer.queue`),
  `packages/shared/src/keybindings.ts` (default `mod+shift+enter`)

Text only; attachments stay with the composer draft.

### Chat: stop-hook follow-ups

`MessagesTimeline.logic.ts` keeps a turn expanded through a stop-hook warning and
the self-check reply that follows it.

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
