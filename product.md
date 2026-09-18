# Touchdown

A GitHub Action that keeps correct GitHub Deployment records for a deploy you run yourself. A recorder, not a deployer: no build, no cloud knowledge, no comment management.

## Problem

Every self-hosted deploy re-implements what Vercel's GitHub App does — badly — because the Deployments API has traps:

- `steps.<id>.outcome` is the string `"skipped"` (truthy), so naive `||` fallbacks report failures on successful deploys.
- `auto_inactive` only touches prior **non-transient, non-production** deployments, so it is inert for transient previews and for production.
- `GITHUB_SHA` is the **merge** commit on `pull_request`, so using it as the deployment `ref` breaks the PR-timeline link.
- `listDeployments` is paginated (default 30); retirement logic that ignores this silently misses deployments.
- `inactive` renders as "destroyed" only for **transient** environments.
- Only one `environment_url` is supported per deployment.

## Model

- **`environment`** = the app's environment (e.g. `production`, `pr-preview`). Constant — not one per PR. Keeps GitHub Environments at a fixed small count.
- **`group`** = the lifecycle (e.g. `pr:123`, `prod`). Scopes reuse, retirement, and deactivation.
- **One deployment per target.** GitHub supports only one `environment_url` per deployment, so multi-app means multi-deployment, joined by a shared `group`.
- **Ownership.** Every deployment carries a payload stamp. The action only ever retires or deactivates deployments it created.

## Non-goals

Not a deployer. No build, no cloud/runner knowledge, no PR comments, no environment protection rules, no runtime hand-holding for consumers.

## Acceptance criteria

### Functional

- **F1** `start` creates one deployment per target for the resolved ref, then immediately posts `in_progress` with the run URL as `log_url` and a description. Honours `transient` / `production`.
- **F2** `finish` posts a terminal status from the **explicit** `status` input — never inferred from step context. `cancelled` / `skipped` map to `error` via a documented, hardcoded table.
- **F3** On success, `finish` sets `environment_url` (validated absolute `http(s)` URL) and `log_url`; truncates `description` to 140 characters.
- **F4** `deactivate` marks every owned deployment matching `group` `inactive`; idempotent (zero matches → no-op, exit 0). It is an explicit, caller-invoked, group-scoped teardown that acts across all environments for the group, so invoking it with a production-bearing group is itself the opt-in.
- **F5** On `finish` success, retires prior owned deployments matching scope, **excluding the current one**.
- **F6** Never retires `production` deployments on `finish` unless explicitly opted in (`retire-production: true`).
- **F7** `sweep` mode for orphan reaping is deferred; not in v0.
- **F8** One call handles N targets. `finish` applies a single `status` across all of them; per-target outcomes are deferred.

### Correctness

- **C1** N concurrent groups across M environments each keep their own active deployment — no cross-clobber.
- **C2** Retirement paginates to a bounded, documented cap.
- **C3** `ref` defaults to `pull_request.head.sha` on PRs, else `github.sha`; overridable.
- **C4** Re-runs reuse an existing deployment for (`environment`, `ref`, `group`) instead of duplicating.
- **C5** `auto_inactive` is always sent `false` explicitly; the choice and reasoning are documented.
- **C6** API errors are never swallowed; `fail-on-error` defaults to `true`.
- **C7** `inactive` rendering per environment type is documented.
- **C8** Reuse, retirement, and deactivation only ever touch deployments carrying this action's ownership stamp for the matching `group`.

### Security

- **S1** Ownership marker in `payload`; the action may only retire deployments it created. A bad `group` must never deactivate another tool's or a human's deployment.
- **S2** Validate inputs: `environment` ≤255 chars, no control characters; `group` bounded; `ref` a valid SHA or refname; URL absolute `http(s)`. Reject, don't coerce.
- **S3** No input is ever interpolated into a shell; API-first.
- **S4** API-only. Never checks out or executes PR code; docs must not combine it with `pull_request_target` + checkout.
- **S5** Minimal, pinned dependency surface + lockfile; no `curl | sh`.
- **S6** Fail-closed: on error, never post `success`.
- **S7** Bounded pagination and call counts.

### Non-functional

- **N1** Requires only `deployments: write`.
- **N2** Token and URLs are never logged; redacted on error.
- **N3** Event-agnostic: works from `push`, `pull_request`, `workflow_dispatch`, and PR-close.
- **N4** Public repo, consume by immutable SHA. Not listed on the Marketplace in v0.

### Testing / distribution

- **T1** Unit tests (mocked API): all modes, error paths, truncation, URL validation, pagination cap, ownership filtering, multi-target.
- **T2** Integration test on a real throwaway repo: PR-timeline entry, View-deployment button, retire-on-second-push, deactivate-on-close, C1 isolation.
- **T3** Lint clean: `actionlint`, `oxlint`, `oxfmt --check`, `tsc --noEmit`, wired through lefthook.
- **D1** README recipes: constant-env, per-PR-env, multi-app; migration notes from `bobheadxi/deployments`.
- **D2** Marketplace readiness (branding, category, floating major tag) is a later step, not v0.
