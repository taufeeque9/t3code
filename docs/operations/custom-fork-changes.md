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
- `apps/web/src/components/usage/ProviderLoginDialog.tsx`, and the **Sign in**
  button in upstream's `UsageLimits.tsx`

**On conflict:** the button lives inside an upstream file. Re-apply it to
upstream's card rather than reviving a separate page.

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
- `apps/web/src/components/usage/UsageLimits.tsx`: the `ExtraUsage` bar

**On conflict:** drop all of it the moment upstream reports extra usage itself.

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
- `apps/mobile`: `projectThreadStartTurn.ts`, `use-project-actions.ts`,
  `use-thread-outbox-drain.ts`, `NewTaskDraftScreen.tsx`
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
(`apps/web/src/routes/usage.tsx`, `SidebarChrome.tsx`).
