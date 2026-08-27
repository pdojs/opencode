---
applyTo: "**"
---

# Best Practices for Plans and Work Breakdown Structures

Distilled from the hosted-chat-overhaul planning cycle.

---

## 1. Ground investigations in code, not speculation

Every "Preliminary investigation" section must cite verified code findings: file paths, line numbers, function names, and observed behavior. Replace words like "likely," "probably," or "should" with what the code actually does.

**Bad**: "The tool renderer probably doesn't clean up state when the response ends."
**Good**: "`tool-invocation-part.ts:55-82` is a passive renderer with no lifecycle hook. `server-chat.ts:1351-1394` finalizes blocks but does not reconcile emitted tool records against visible cards — this is the root cause of stuck RUNNING states."

## 2. Follow a clear planning phase before implementation

The planning phase must produce clarity on five things, in this order:

1. **Goal** — one sentence: what the user gets when this is done.
2. **Problem statement** — what is broken or missing today, stated as observable symptoms.
3. **Preliminary investigation and root cause** — verified code findings with file:line citations explaining _why_ the problem exists. No speculation. If a definitive root cause cannot be established despite thorough investigation, switch to hypothesis-driven mode (see §2a).
4. **Definition of Done** — observable, testable outcomes that a reviewer can verify. Define success _before_ planning the work.
5. **WBS towards the goal, grounded in code** — numbered steps an implementer can execute sequentially, each referencing specific files and functions. The WBS is a path from root cause to Done, not an abstract wishlist.

Each workstream in a plan document follows this structure:

```
### Goal
One sentence: what the user gets when this is done.

### Problem
What is broken or missing today, stated as observable symptoms.

### Preliminary investigation and root cause
Verified code findings with file:line citations. No speculation.
Identifies the root cause — the specific code path, missing hook,
or architectural gap that explains the problem.

If root cause cannot be determined, switch to hypothesis mode (see §2a):
list each hypothesis with supporting evidence, expected outcome
if the hypothesis is correct, and a concrete test to confirm or rule it out.

### Definition of Done
Observable, testable outcomes — not "improved" or "better."
Defined before the WBS so the resolution is measured against clear criteria.

### Resolution via WBS
Numbered steps grounded in code that an implementer can execute sequentially.
Each step references specific files, functions, or modules.

### Specific change surface
Exhaustive list of files/functions that will be created or modified.
```

## 2a. Hypothesis-driven investigation when root cause is uncertain

Sometimes a thorough investigation narrows the problem to a specific area but cannot pinpoint a single root cause. When this happens, switch to hypothesis mode instead of speculating or stalling.

### When to use this mode

- You have explored the relevant code paths and can cite what you checked.
- Multiple plausible explanations remain, and you cannot distinguish between them without runtime experiments or targeted changes.
- Continuing to investigate without acting would produce diminishing returns.

### Structure

Each hypothesis becomes a lightweight workstream with this template:

```
### Hypothesis N: <concise statement>

**Supporting evidence**: what code/behavior points toward this explanation.
**Expected outcome if correct**: what observable change confirms this hypothesis.
**Test plan**: a concrete, minimal experiment — a code change, a diagnostic log,
a targeted test — that will confirm or rule out this hypothesis.
**Result**: (filled in after the test) confirmed / ruled out / inconclusive.
**Reflection**: what was learned and how it informs next steps.
```

### Rules

1. **Test all hypotheses** — do not stop at the first plausible one. Queue them all, execute each test, and record the result before deciding.
2. **Set expectations before testing** — write the expected outcome _before_ running the experiment so results are evaluated against a prediction, not rationalized after the fact.
3. **Reflect after each test** — update the hypothesis entry with the result and a brief reflection. What did you learn? Does it change the remaining hypotheses?
4. **Create new workstreams from results** — after testing, create concrete resolution workstreams grounded in what you now know. These follow the standard workstream template from §2.
5. **Don't hold up good for great** — if a hypothesis test produces a working fix, proceed with it. Defer optimizations, elegance, or deeper root-cause archaeology to a later workstream. Ship the fix, then improve.
6. **Keep hypothesis scope minimal** — each test should be the smallest change that distinguishes the hypothesis from alternatives. Avoid bundling multiple hypotheses into one experiment.

### Example

```
### Hypothesis 1: Stale cache entry survives reconnect

**Supporting evidence**: `session-cache.ts:112-130` evicts on explicit
disconnect but not on transport-level reconnect. Reconnect path in
`ws-transport.ts:88` does not call `evictSession()`.
**Expected outcome if correct**: adding `evictSession()` to the reconnect
handler eliminates the stale-state symptom after reconnect.
**Test plan**: add `evictSession()` call at `ws-transport.ts:92`, reproduce
the reconnect scenario, observe whether stale state reappears.
**Result**: Confirmed — stale state no longer appears after reconnect.
**Reflection**: Root cause is the missing eviction on reconnect. Proceed
with this fix. Defer broader cache lifecycle audit to a follow-up workstream.
```

## 3. Separate active scope from deferred scope

When scope needs to shrink, move items to a dedicated "Deferred / nice to have later" section instead of deleting them. This preserves the investigation work and makes future planning faster.

Keep deferred items terse — one bullet per item with a short rationale for why it was deferred.

## 4. Define the dependency graph explicitly

List every workstream with its dependency status:

```text
WS1 (attachments)      — independent
WS3 (command wiring)   — depends on WS2 (session UX), WS6 (MCP surface)
```

Follow with a parallelism note: which workstreams can start concurrently, which must sequence, and why.

## 5. Map workstreams to the branching model

Each workstream gets a dev branch under the feature branch:

```
main ← feature/<epic> ← dev/<workstream>
```

List all suggested branch names in the document header so the team can create them without guessing.

Every `dev/*` branch must follow the commit discipline described in §19.

## 6. Show specific change surfaces

Abstract descriptions waste reviewer time. List every file and function that will be touched:

**Bad**: "Update the chat UI to support attachments."
**Good**:

```
- chat/src/chat-input.ts
  - dispatchSend() — add file payload encoding
  - file input handler (lines 182-190) — wire to hosted state
- chat/src/gateway-client.ts
  - add attachment upload method
```

## 7. Define Done as observable outcomes

Each workstream's Definition of Done should be a list of testable statements that a reviewer can verify:

**Bad**: "Attachments work in chat."
**Good**:

- "Dragging a file onto the chat input attaches it to the next message."
- "The gateway receives the attachment in the `chat.send` payload and stores it."
- "Attached files render inline in the message bubble with filename and size."

## 8. Iterate the plan before implementation

Run multiple review rounds with the stakeholder. Each round should produce specific edits, not vague approval. Common refinement patterns:

- **Scope adjustment**: "Move X to deferred" or "Add Y as a new workstream"
- **Structure improvement**: "Fold Python tooling into WS6 instead of a standalone workstream"
- **Investigation gaps**: "What does the code actually do at line N?" — go verify, then update

Only start implementation after explicit approval of the plan.

## 9. Review cycle: completeness, correctness, and actionability

Every plan must pass a structured review cycle before implementation starts. The cycle has three phases — **fresh-context review**, **structured gap analysis**, and **iteration to exit** — and must be run in a brand-new session with no prior planning history.

### Why a fresh context is required

The planner accumulates context: investigated code paths, rejected alternatives, implicit assumptions. That context fills in blanks silently. A fresh-context reviewer sees only what is written down — exactly what an implementer picking up the plan cold will see. Without a fresh-context review, plans routinely pass author review with missing file paths, stale citations, and steps that require knowing things never written in the document.

This is a **mandatory gate**, not an optional polish step. Do not start implementation until the review cycle completes with no open findings.

---

### Phase 1 — Fresh-context review

Open a **new session with no conversation history**. Load only the plan document (and its companion `requirements.md` / `design-proposal.md` if present). Do not load the planning session history or any notes from how the plan was written.

For each workstream, run the following three checks:

#### Check 1: Completeness

A plan is complete when every piece of information an implementer needs is written in the document itself — not implied, not referenced from a conversation, not assumed from familiarity with the codebase.

Flag `INCOMPLETE` for any of the following:

- A WBS step references a file, function, or concept not defined or cited elsewhere in the plan.
- A workstream depends on another but the dependency is not stated.
- A Definition of Done item refers to a behavior the plan never describes how to produce.
- A change surface lists a file but no WBS step explains what change is needed there.
- An acronym, variable name, or term is used without being defined in the plan.
- The implementation order is absent or leaves ordering ambiguous for dependent workstreams.

#### Check 2: Correctness

A plan is correct when its citations match the codebase as it exists today — not as it existed when the investigation started, and not as the planner remembers it.

Flag `INCORRECT` for any of the following:

- A cited file:line does not exist or does not contain what the plan claims.
- A cited function name, type name, or export does not match the current source.
- A block type, event name, or config key cited in the plan is not present in the codebase.
- A "verified finding" is stated without a file:line citation (treat as unverified = incorrect).
- A root cause or investigation finding is phrased with hedging language ("likely", "probably", "should") — these are unverified and must be checked before the plan is approved.

Spot-check at least **two file:line citations per workstream** by opening the cited file and confirming the cited content is present.

#### Check 3: Actionability

A plan is actionable when an implementer with codebase access but zero planning context can execute every WBS step without asking the author a question.

Flag `UNACTIONABLE` for any of the following:

- A step says what to do but not where (missing file or function name).
- A step says where but not what (e.g. "update the handler" with no description of the change).
- A step implies knowledge of an earlier investigation finding that is not restated in the plan.
- A step's expected outcome is not described, so the implementer cannot verify it was done correctly.
- A commit message is not named for steps that require one (see §19).
- A step bundles multiple logical changes that §19 requires to be separate commits.

---

### Phase 2 — Gap log

Collect all findings into a gap log with the following structure per finding:

```
[INCOMPLETE | INCORRECT | UNACTIONABLE] WS<N> step <N> — <short description>
Detail: <what is missing, wrong, or unclear>
Fix: <what the plan must say to resolve this finding>
```

A plan with zero findings passes the review cycle and may proceed to implementation.

A plan with one or more findings must go back to the planner for revision (Phase 3).

---

### Phase 3 — Iterate to exit

Return the gap log to the planner. For each finding:

1. The planner investigates the gap (opening the codebase if needed to verify a citation).
2. The plan document is updated to resolve the finding.
3. The finding is marked `RESOLVED` in the gap log with a note on what changed.

After all findings are resolved, run Phase 1 again — a fresh-context pass on the revised plan — to confirm no new gaps were introduced and no old gaps are still present. Continue iterating until a full Phase 1 pass produces zero findings.

**Exit condition**: Phase 1 completes with zero `INCOMPLETE`, `INCORRECT`, or `UNACTIONABLE` findings. The plan is approved for implementation.

---

### The implementer test

Before approving, apply this test as a final check: an implementer with access to the codebase but **zero context about the planning conversation** should be able to pick up the plan and execute it start-to-finish without asking a single question. If any step would prompt a question, that step fails the actionability check and must be revised before approval.

## 10. Track todos alongside the human-readable plan

The plan document (`plan.md` or a WBS `.md`) is the source of truth for prose, rationale, and structure. Use a parallel tracking system (SQL, project board, issue list) for execution status:

```sql
INSERT INTO todos (id, title, description, status) VALUES
  ('chat-session-rail', 'Restore sessions rail',
   'Move session list/delete from Settings into chat window left panel', 'pending');
```

Update status as work progresses: `pending → in_progress → done`. This separation keeps the plan clean and the execution state queryable.

## 11. Keep ownership clear between workstreams

When workstreams interact, be explicit about who owns what:

- "WS6 **owns** MCP migration and legacy surface removal."
- "WS3 **consumes** the MCP surface WS6 builds — it does not independently own migration."
- "WS5 **depends on** WS6's canonical tool-call lifecycle definition."

This prevents duplicate work and scope creep at workstream boundaries.

## 12. Ask one clarifying question at a time

Don't bundle design decisions. Each question should be answerable in isolation:

**Bad**: "Should we use MCP for tools, and also should credentials go in keychain or encrypted store, and do you want multi-session?"
**Good**: "Should tool registration use MCP exclusively, or keep the existing non-MCP surfaces alongside?"

Follow up with the next question only after the first is resolved.

## 13. Move complexity down, not up

When a workstream becomes too complex, the response is to split or defer — not to add more scope to the plan:

- If a workstream has more than 8 resolution steps, consider splitting it into two workstreams.
- If a design decision has more than two viable options, defer it with a decision deadline rather than speculating in the plan.
- If a workstream's risk is disproportionately high, sequence it last so other workstreams are unblocked.

## 14. Include a recommended implementation order

The implementation order often differs from the document order. State it explicitly with dependency justifications:

```
1. chat-session-rail (WS2)
2. chat-command-wiring (WS3) — requires WS2 session UX + WS6 MCP surface
3. mcp-tool-discovery (WS6) — includes local Python tooling
4. tool-lifecycle-finish (WS5) — requires WS6 canonical lifecycle
5. passwordless-credentials (WS7) — highest risk, land last
```

## 15. Version the plan document in the repo

Keep the WBS in the repo (e.g., `.github/dev/patches/<epic>-wbs.md`) so it's versioned, reviewable, and discoverable. Don't rely on external tools or ephemeral session state for the canonical plan.

## 16. Verify every change is wired in before marking a step done

A change that exists in a file but is not reachable from a real call site is the most common silent failure of this planning process. New helpers, components, hooks, commands, providers, and config keys must be **wired in** — exported, imported, registered, mounted, dispatched, and exercised by an end-to-end path — before the WBS step that introduced them is marked done.

### What "wired in" means

For every change, identify the **integration surface**: the set of edges that must exist for the change to actually run in production. Examples:

- **New function/class** — exported from its module _and_ imported by at least one caller that runs in the real entry path.
- **New React/SwiftUI component** — instantiated by a parent that is reachable from the app root, not just defined and rendered in tests.
- **New CLI command/subcommand** — registered with the command framework (e.g. Commander `addCommand`) and reachable from `--help`.
- **New IPC/RPC method** — registered in the server method table _and_ called by at least one client; capability flags advertised on both sides if applicable.
- **New event/hook** — both emitter and listener exist, listener is attached during the actual lifecycle (not only in a test fixture).
- **New config key / flag** — read by the code that should react to it, with a default and a documented surface (CLI flag, config file, env var).
- **New provider/plugin/extension** — added to the registry/manifest the host enumerates at runtime.
- **New DB column / migration** — migration runs on startup, code reads/writes the column, and a backfill path exists if needed.
- **New UI string / asset** — referenced by the rendering surface, included in the bundle, and shown on a path the user can reach.

If the change does not have a documented integration surface in the WBS step, the step is incomplete.

### Wire-in verification protocol

After implementing each WBS step, run this protocol _before_ marking it done:

1. **Trace forward from the change** — for each new symbol, follow its imports/registrations until you land on a real entry point (app bootstrap, CLI parser, request handler, UI route, lifecycle event). If the trace dead-ends, the change is not wired in.
2. **Trace backward from the user-visible outcome** — start from the Definition of Done statement and walk the call graph back to the new code. If the new code is not on that path, it is not wired in.
3. **Grep for orphaned exports** — search the codebase for imports of the new symbol. Zero importers (outside tests) means the change is dead code.
4. **Run the real entry path** — exercise the feature through the actual product surface (CLI invocation, app launch, HTTP request, UI interaction), not only through unit tests. Unit tests can pass against a module that nothing imports.
5. **Confirm the observable outcome** — match the run against the Definition of Done. If the DoD says "the user sees X," verify X appears via the real surface, not only via a mock.

### Wire-in evidence in the plan

Every WBS step that introduces a new symbol must list its wire-in edges explicitly in the change surface, not just the file where the symbol is defined:

**Bad**:

```
- src/foo/new-helper.ts — add formatThing()
```

**Good**:

```
- src/foo/new-helper.ts — add and export formatThing()
- src/foo/index.ts — re-export formatThing
- src/bar/consumer.ts:142 — replace inline formatting with formatThing() call
- src/cli/commands/show.ts:88 — pass formatted value to renderTable()
```

The reviewer should be able to read the change surface and see a complete path from definition to user-visible effect.

### Definition of Done must include a wire-in check

Every workstream's Definition of Done must contain at least one statement that can only be true if the change is wired in end-to-end. Examples:

- "Running `openclaw foo --bar` prints the new formatted value." (not: "`formatThing()` returns the formatted value.")
- "Opening the chat window shows the sessions rail on the left." (not: "`SessionRail` component renders without errors in isolation.")
- "Sending a message with an attachment results in the gateway storing the file under `~/.openclaw/attachments/`." (not: "`uploadAttachment()` posts to the upload endpoint.")

If a DoD statement could pass while the new code is unreachable, rewrite it.

### Common wire-in failure modes

- New helper added next to existing helper, but the call site still uses the old one.
- New component file created, but no parent imports it.
- New command file added under `src/commands/`, but the command index does not register it.
- New gateway method implemented server-side, but the client never calls it (or vice versa).
- New capability advertised in one direction only — handler exists but the peer never enables it.
- New config key read but never set; or set but never read.
- Migration written but not added to the migration runner's manifest.
- New plugin built but not added to the plugin registry / `package.json` workspaces / manifest.

When reviewing a step, scan for these patterns explicitly.

## 17. Prevent cross-runtime security and state-I/O drift

Plans that touch state files, credentials, keychains, encryption, pairing, config, launch services, or app/gateway boot must include explicit drift guardrails. These areas usually have more than one implementation surface: TypeScript gateway/CLI code, Swift macOS app code, shared OpenClawKit code, tests, install/restart scripts, and runtime state under `~/.openclaw`. A fix in only one surface is incomplete unless the plan proves the other surfaces are intentionally unaffected.

### Required drift inventory

Before defining workstreams, list every implementation of the same responsibility:

- **Sensitive file I/O** — async TypeScript helpers, sync TypeScript helpers, Swift readers/writers, migration code, backup/forensic writers, tests, and scripts that inspect or mutate files directly.
- **Config health and recovery** — readers, writers, health-state persistence, backup rotation, anomaly snapshots, audit logs, and restore paths.
- **Keychain and credential access** — Data Protection Keychain, login/legacy keychain, gateway-compatible keychain, sentinel/helper binaries, Swift app stores, shared app kit stores, and daemon/gateway token paths.
- **Pairing and identity state** — device identity, device auth, pending/paired state, app node pairing, CLI operator pairing, and gateway WebSocket handshake logic.
- **Launch/rebuild/runtime surfaces** — app launch, LaunchAgent install/restart, gateway boot, stale `dist/` detection, and post-relaunch verification.

The plan must state which surface owns each responsibility and which surfaces are mirrors that must be kept behaviorally equivalent.

### Required symmetry rules

When one runtime gains a behavior, every mirror must either gain the same behavior or be explicitly exempted with code evidence:

- If TypeScript reads or writes an encrypted envelope, Swift readers/writers for the same file class must read/write the same envelope or the plan must prove Swift never touches that path.
- If an async helper becomes encrypted-aware, any sync helper used by startup, config, tests, or recovery must become encrypted-aware too.
- If state health is written through encrypted file I/O, every reader of that health file must use encrypted-aware reads. Raw reads are allowed only for paths classified plaintext by the file-I/O registry.
- If a migration converts sensitive plaintext to encrypted envelopes, backup files, `.bak` files, `.clobbered.*` snapshots, temp files, and forensic artifacts must be included in the encryption and retention strategy.
- If the file-I/O registry classifies a path as encrypted, code must not use raw `fs.readFile`, `fs.writeFile`, `Data(contentsOf:)`, or `Data.write(to:)` for that path unless the step documents a raw-by-design exception.

### Keychain no-prompt invariant

Plans that touch keychain or credential code must preserve this invariant: background, gateway-compatible, cleanup, migration, and stale-ACL paths must never trigger macOS password dialogs.

Required plan details:

- Every `SecItemCopyMatching`, `SecItemDelete`, and legacy-keychain enumeration path must state whether UI is allowed. Default is **no UI**.
- No-UI paths must include `kSecUseAuthenticationUI: kSecUseAuthenticationUISkip` where applicable and use `SecKeychainSetUserInteractionAllowed(false)` around legacy login-keychain operations that can still prompt despite the query flag.
- Stale or restrictive ACLs must be treated as unreadable/repairable state, not as a reason to prompt from background or startup code.
- If an interactive repair is required, the plan must name the user-initiated surface that owns it and prove daemon/gateway/background paths cannot enter it.
- Rebuilds and ad-hoc signing changes must be considered: keychain ACLs tied to an old binary identity can regress after every local rebuild.

### Required regression and runtime checks

Definitions of Done for these workstreams must include checks that fail when drift reappears:

- Header checks for all sensitive state files and their backup/forensic siblings, including `*.bak`, `.clobbered.*`, and migration artifacts.
- A "no new artifacts" check after app relaunch: record counts and newest timestamps for recovery/forensic files before and after restart, then prove no unexpected growth occurred.
- A raw-read/write search for sensitive paths across TypeScript, Swift, scripts, and tests, with each remaining raw access justified by file classification or test setup.
- A keychain-prompt guard check: inspect touched keychain paths for UI-suppression flags and legacy interaction disabling, and verify logs do not show prompt/interaction failures after relaunch.
- A stale-bundle check: prove the running app/gateway bundle contains the changed code, not only that source tests pass.
- A real restart path check: run the app/gateway through the canonical rebuild/relaunch flow and verify listener health, pairing state, config readability, and encrypted-at-rest state.

### Reviewer drift checklist

Reviewers must reject plans or implementations in these areas when any of the following are true:

- A change updates TypeScript state I/O but not the Swift/shared app surfaces that read or write the same files.
- A change updates writes but leaves reads raw, or updates async reads but leaves sync reads raw.
- A recovery path writes plaintext copies of sensitive data into backups, snapshots, logs, temp files, or audit artifacts.
- A health/marker file is written through one abstraction and read through another incompatible abstraction.
- Keychain code can show UI from startup, background, gateway, daemon, migration, cleanup, or stale-ACL paths.
- Validation only exercises unit helpers and not the real app/gateway launch path.
- Runtime verification checks only "process is running" and not the specific persisted state, artifact growth, and no-prompt/no-pairing-regression outcomes.

## 18. Preserve gateway auth as a single reconciled authority

Plans that touch gateway auth, Control UI auth, onboarding, daemon/service installation, service launch, SecretRefs, Keychain token storage, pairing/device-token fallback, or `OPENCLAW_GATEWAY_TOKEN` must model gateway auth as a single credential authority with derived surfaces. Do not plan one-off fixes that only change a producer or consumer without reconciling the whole auth graph.

### Required gateway auth inventory

Before defining workstreams, list every active gateway auth source and classify it as one of: `authority`, `derived cache`, `override`, or `legacy compatibility`.

The inventory must include every relevant surface:

- `gateway.auth.token` and `gateway.auth.password`
- `gateway.remote.token` and `gateway.remote.password`
- `OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_GATEWAY_PASSWORD`
- Secret files such as `/run/secrets/openclaw-gateway-token`
- Keychain or SecretRef-backed gateway credentials
- launchd/systemd/service environment values
- macOS app and installer token setup paths
- Control UI/browser in-memory settings and `/api/local-auth`
- `GatewayClient` device-token fallback and paired-device auth state
- node-host, CLI, webchat, and remote-mode credential resolution

For each source, the plan must state who writes it, who reads it, which runtime can treat it as canonical, and how drift is detected or repaired.

### Required authority and reconciliation design

Every gateway-auth plan must define:

1. **Canonical lease owner** - the module or startup step that owns the effective auth mode, token/password source, non-secret fingerprint, and version/issued metadata when available.
2. **Precedence policy** - deterministic rules for local mode, remote mode, container runtime, explicit CLI overrides, SecretRefs, env vars, and service environments.
3. **Startup reconciliation** - the check that runs before gateway HTTP/WebSocket listen and either repairs safe derived surfaces or fails with one actionable diagnostic.
4. **Client projection** - how CLI, node-host, Control UI, webchat, and device-token fallback obtain the current credential without independently inventing precedence.
5. **Redacted diagnostics** - doctor/log/UI output that reports winning source, stale loser sources, fingerprints, and repair commands without printing raw tokens/passwords.

If a plan changes only a single edge, for example onboarding token generation or Control UI token paste behavior, it must explain why the canonical authority and reconciliation rules are unaffected.

### Gateway auth anti-drift rules

- No runtime may silently generate a new gateway token while another active source still claims authority unless startup reconciliation records and repairs the drift.
- Service units should not embed long-lived `OPENCLAW_GATEWAY_TOKEN` values as canonical truth. If legacy units do, plans must include stale-token detection and a reinstall/repair path.
- `gateway.remote.*` must not shadow local gateway auth in local mode. Remote credentials are active only when remote mode, explicit remote URL, or documented remote exposure requires them.
- Control UI must not rely on durable browser token storage for local connections when a trusted local auth/discovery path can provide the current credential.
- Device-token fallback is a bounded trusted-endpoint recovery path, not a way to hide persistent shared-token drift.
- SecretRef or Keychain failures in daemon/background paths must preserve the no-prompt invariant from §17 and surface repair through a user-initiated path.

### Required regression and runtime checks

Definitions of Done for gateway-auth workstreams must include checks that fail when authority drift reappears:

- A historical-regression matrix covering ignored `OPENCLAW_GATEWAY_TOKEN`, container token/config mismatch, stale embedded service token, quickstart rerun Control UI auth, local-auth auto-fetch, SecretRef recovery, and device-token fallback.
- A doctor/runtime report showing the winning source and every stale loser source without printing secrets.
- A startup test proving fatal drift is caught before the gateway accepts clients.
- A local Control UI connection test proving no manual token paste is needed when trusted local auth is available.
- A local-vs-remote credential test proving `gateway.remote.*` cannot shadow local auth unless remote mode or explicit remote URL is active.

## 19. Commit discipline on dev branches

Commits on `dev/*` branches must be self-contained logical units. This rule exists so that:

- Any commit can be built and tested in isolation without carrying forward broken state.
- The PR diff is reviewable step-by-step rather than as one undifferentiated blob.
- Bisection (`git bisect`) works — each commit either passes or fails CI clearly.

### Rules

1. **One logical change per commit.** A commit should do one thing: add a type, wire a component, add a test, emit a block. Do not bundle unrelated changes (e.g. a new type + its component + server emission) into a single commit unless they are genuinely inseparable.
2. **Every commit must build.** Running `pnpm build` (and `pnpm tsgo`) at any commit in the branch's history must succeed. Do not commit a type and defer its import to three commits later — import it in the same commit.
3. **Tests pass at each commit.** `pnpm test` must not regress at any commit. Add or update tests in the same commit as the code they cover, not as a trailing cleanup commit at the end of the branch.
4. **No squash-at-the-end.** Do not accumulate all changes locally and squash into one large commit when opening the PR. The full logical history must be present in the PR. Squashing is reserved for merge-to-feature (at the PR gate), not for work within the dev branch.
5. **Commit message format.** Follow the existing action-oriented Conventional Commit style: `Scope: short description` (e.g. `Chat: add RequestContextBlock type`, `Gateway: emit request_context before LLM run`). Keep subject lines under 72 characters.

### In plan WBS steps

Each WBS step should map to one or a small number of commits. When writing a WBS step, note the expected commit message so the implementer knows the commit boundary:

**Bad WBS step**: "Add the request_context block type, part component, and wire it into message-bubble."
**Good WBS step**:

```
1. Add `RequestContextBlock` to `response-types.ts`. Commit: `Chat: add RequestContextBlock type`.
2. Create `request-context-part.ts` component. Commit: `Chat: add request-context-part component`.
3. Import and wire into `message-bubble.ts`. Commit: `Chat: wire request-context-part into message-bubble`.
```

### What counts as "inseparable"

A set of changes is inseparable only when committing any subset would leave the codebase in a state where `pnpm build` or `pnpm tsgo` fails. For example:

- Adding a type export and updating the union type it belongs to — inseparable (the union is broken mid-way).
- Adding a type and creating the component that uses it — separable (type lands first, component in the next commit).
- Renaming a symbol across 10 call sites — inseparable (build fails with partial rename).

---

## Summary checklist

Before approving a plan for implementation:

- [ ] Every investigation section cites file:line, not speculation
- [ ] When root cause is uncertain, hypotheses are listed with evidence, expected outcomes, and test plans
- [ ] Hypothesis results are recorded with reflections before creating resolution workstreams
- [ ] Every workstream follows the same template
- [ ] Dependency graph is complete and consistent
- [ ] Branch names are listed
- [ ] Each WBS step maps to a named commit (or small set of commits) that builds and tests cleanly in isolation
- [ ] Change surfaces list specific files and functions
- [ ] Change surfaces include the wire-in edges (registrations, imports, mount points), not only the files where new symbols are defined
- [ ] Definition of Done uses testable statements
- [ ] Definition of Done includes at least one statement that fails if the change is not wired in end-to-end
- [ ] Security/state-I/O plans include a drift inventory across TypeScript, Swift, shared app code, scripts, tests, and runtime artifacts
- [ ] Mirrored encrypted-state readers and writers are updated symmetrically, or exemptions are justified with code evidence
- [ ] Keychain plans preserve the no-prompt invariant for background/startup/gateway/cleanup/migration paths
- [ ] Backup, forensic, temp, health, marker, and migration artifacts have explicit encryption and retention behavior
- [ ] Runtime checks include stale-bundle detection and post-relaunch artifact-growth/no-prompt verification when relevant
- [ ] Gateway-auth plans identify one canonical credential authority and classify every auth source as authority, derived cache, override, or legacy compatibility
- [ ] Gateway-auth plans include startup reconciliation, client projection, redacted diagnostics, and tests for stale service/env/config/container/browser/device-token drift
- [ ] Deferred items are preserved, not deleted
- [ ] Implementation order is stated with dependency rationale
- [ ] Cross-workstream ownership is explicit
- [ ] Plan has been through at least one stakeholder review round
- [ ] Fresh-context review cycle (§9) completed: zero INCOMPLETE, INCORRECT, or UNACTIONABLE findings
- [ ] Every cited file:line was spot-checked against the current codebase (at least two per workstream)

Before marking any WBS step done:

- [ ] Forward trace from new symbols reaches a real entry point
- [ ] Backward trace from the Definition of Done reaches the new code
- [ ] No new exports are orphaned (zero non-test importers)
- [ ] The change has been exercised through the real product surface, not only via unit tests
- [ ] The observable outcome described in the Definition of Done has been verified on that real surface
- [ ] For sensitive state changes, all mirrored read/write paths and artifact paths pass encrypted-at-rest/header checks
- [ ] For keychain changes, every touched read/delete/enumeration path has explicit no-UI behavior unless it is a named user-initiated repair surface
