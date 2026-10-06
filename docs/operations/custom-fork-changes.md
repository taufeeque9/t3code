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
  every later run until the checkout was cleaned by hand. Its active-session
  guard counts live Orchestration V2 runs, falling back to the V1 session table
  on databases that predate V2.
- `.gitignore` ignores those generated `scripts/lib/*.d.ts`
- `.github/workflows/custom-ci.yml`, `.github/workflows/custom-upstream-sync.yml`
- `.github/workflows/ci.yml` restricts upstream's CI to `main` so fork branches do not run it

**On conflict:** keep the fork's values. Take upstream's structural changes to
the build script and re-apply the identity constants on top.

### Claude account sign-in from the Limits view

Repairs an expired Claude credential without a terminal. Upstream reports the
broken account but offers no way to fix it.

- `apps/server/src/limits/ProviderLoginService.ts` and its test
- `apps/server/src/provider/ClaudeProvider.ts` and its provider-registry test
- the instance-registry test, whose Claude fixture
  (`provider/testing/ProviderInstanceRegistryLive.fixture.mjs`) reports signed out
  when a sibling `claude-account-state` file says so
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
identity (no email, plan, API key, non-first-party backend, or token source other
than `none`) as signed out; otherwise Claude reports the expired login as a working
account with unsupported limits and the repair action disappears after refresh.
After a sign-in the client refreshes that instance with `refreshModels`, which is
upstream's way to drop its cached capabilities.

**On conflict:** the collection is fork-owned, while the render line and the
signed-out check sit in upstream-owned files. Re-apply the smallest patches until
upstream recognizes expired Claude authentication. Retire the whole thing once upstream
offers an equivalent Claude sign-in flow. Upstream's generic `ProviderAuthFlow`
helper (browser and device-code interactions, credential bindings) has no
production caller yet, and only Antigravity exposes an auth controller. A Claude
controller built on it would replace `ProviderLoginService`.

### Claude multi-account support

Switch between Claude accounts in the same thread while preserving the provider
session. Each account remains a separate provider instance with its own
`CLAUDE_CONFIG_DIR`, while compatible accounts can share one transcript tree.

- `apps/server/src/provider/Drivers/ClaudeHome.ts` keys session continuation on the
  resolved `projects` path, so accounts sharing a transcript tree share continuation.
  Upstream keys on the home directory instead. The function keeps upstream's
  optional environment argument so an inherited `CLAUDE_CONFIG_DIR` resolves the
  same way; upstream's tests for that key are rewritten to the fork's format.

Orchestration V2 already resumes the native thread when the continuation keys
match (`restart_and_resume` in `ProviderSessionTransitionPolicy.ts`) and hands
off a summary otherwise, so the key is the fork's only edit.

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

### Chat: stop-hook follow-ups

A Claude stop hook appends a self-check reply after the real final response, in
the same turn. Upstream treats the last assistant message of a turn as its answer
and folds everything before it under "Worked for ...", which hides the final
response. `deriveTurnFolds` in `MessagesTimeline.logic.ts` leaves a turn unfolded
when it contains a `Stop hook` runtime warning or a `Self-check` reply.

**On conflict:** keep the check in `deriveTurnFolds` and its test ("keeps turns
with a stop-hook self-check fully expanded"). Retire it only once that test passes
on upstream's code without the fork's check.

### Chat: fork from a user message

Upstream forks only after an assistant response. A **Fork from here** button on
a user message forks after the run before it and leaves the message's text in
the new thread's composer, to resend or edit it. It rides upstream's
`thread.fork`; nothing server-side is fork-owned.

- `apps/web/src/components/chat/userMessageFork.ts` and its test map each run's
  starting message to the forkable run before it
- `MessagesTimeline.tsx`: `ForkUserMessageButton`, the `userMessageForkSources`
  prop, and an optional `prompt` on upstream's `onForkFromRun`
- `ChatView.tsx`: computes the sources from the projection's runs and sets the
  forked thread's draft before navigating

A thread's first message has no run before it, so it gets no button.

**On conflict:** keep the button beside upstream's fork-from-response. Retire it
if upstream adds forking before a user message.

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

## Retired: superseded by upstream

### Native conversation forks, end-of-turn queue, worktree prefix setting

Retired on 2026-10-06 when upstream replaced its orchestrator with V2 (#2829),
deleting the V1 code all three were built on.

- Forks: V2's `thread.fork` forks from any completed assistant response, natively
  on Claude, Codex, OpenCode, and Pi, and through a summary handoff elsewhere. The
  fork's sidebar "Fork thread" entry and forking a running thread went with it;
  forking from a user message was re-ported on V2 (above).
- Queue: V2 queues follow-ups on the server and starts the next one only when
  the active run ends, which is the rule the fork carried.
- The `worktreeBranchPrefix` setting gave way to upstream's `branchNamePrefix`;
  only the temporary-branch patch above survives.

Upstream's V2 migrations run as 56–59 here, one ID later, following the shift
described under the sidebar search below. `reconcileV2PreviewMigration` only
matches an `OrchestrationV2` row at 53 or 54, which no fork database has, so the
fork deletes its test, whose fixtures assume upstream's IDs.

### Fuzzy sidebar search over thread contents

Retired on 2026-09-22 after upstream fed its thread search into the sidebar
(#11761): a substring scan over user and assistant messages across connected
environments, with a highlighted excerpt under each row. The fork's fuzzy,
per-unit search let too many threads through to be useful, so the parallel
service, RPC, shared matcher, and client state were deleted and the sidebar is
upstream's again.

One artifact stays: migration ID 50 is the fork's `ProjectionThreadSearchUnits`
table, and upstream's migrations 50 onward run one ID later in this fork, so a
migration test that names IDs needs the same shift. Every
installed database has those IDs applied, so `Migrations.ts` must keep the
shift; renumbering would make the next upstream migration look already applied.
The unused table is left in place. Give future migrations IDs upstream does not
use.

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
(`apps/web/src/routes/usage.tsx`, `SidebarChrome.tsx`). Upstream later added a
stored metric preference; the route prop overrides it while the search param is
present, so a deep link still wins and an ordinary visit resumes the last view.

On 2026-09-07 upstream replaced the per-provider list with the pooled view
(`UsageLimitsPooled.tsx`), deleting the `ProviderLimits` component the fork's
sign-in button and extra-usage bar lived in. Both were re-homed onto the pooled
view rather than kept as a parallel one.
