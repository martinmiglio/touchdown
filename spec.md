# Touchdown — Implementation Spec

Companion to `product.md`. This is the shape of the thing we build.

## Runtime & packaging

- JavaScript action: `runs.using: node24`, `main: dist/index.js`.
- TypeScript source in `src/`, bundled with `@vercel/ncc@0.45.0` to a single committed `dist/index.js`: `ncc build src/index.ts -o dist --source-map --license licenses.txt`.
- `"type": "module"`; `tsconfig` `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`.
- Commit `dist/package.json` = `{"type":"module"}`.
- **No top-level `await`: `src/index.ts` is the entrypoint and does nothing but `void run()`; `src/main.ts` exports `run()` and has no top-level await.**
- Contingency: if Gate C cannot smoke-run `dist/index.js`, flip to Option B (`@actions/core@2.0.3`, `@actions/github@8.0.1`, `module: commonjs`, no `type: module`) — a config flip, not a rewrite.
- Runtime dependencies, exact-pinned: `@actions/core`, `@actions/github` (Octokit), `zod` (v4). Nothing else.
- `package-lock.json` committed; `node_modules` never committed.
- Dev pins: ncc 0.45.0, typescript 5.9.3, @types/node 24.13.5, oxlint 1.83.0, oxfmt 0.68.0, lefthook 2.1.14, vitest 5.0.1, actionlint 1.7.12, action-validator 0.9.0.
- Dev toolchain pinned to Node 24: `oxlint`, `oxfmt`, `tsc`, `actionlint`, `action-validator`, `lefthook`. No eslint/prettier.
- Bun is fine for local installs/tests, but no `Bun.*` APIs in `src/`.
- `check-dist` CI rebuilds and fails if `dist/` is stale.

## Inputs

| Input               | Required     | Default               | Notes                                                                              |
| ------------------- | ------------ | --------------------- | ---------------------------------------------------------------------------------- |
| `mode`              | yes          | —                     | `start`, `finish`, or `deactivate`.                                                |
| `group`             | yes          | —                     | Lifecycle key, e.g. `pr:123`, `prod`. Correlates reuse/retire/deactivate.          |
| `targets`           | start/finish | —                     | JSON array of `{environment, url?, logUrl?, description?}`.                        |
| `ref`               | no           | resolved              | SHA (40-hex) or safe refname. Defaults per event, see C3.                          |
| `token`             | no           | `${{ github.token }}` | Needs `deployments: write`.                                                        |
| `status`            | finish       | —                     | `success`, `failure`, `error`, `cancelled`, or `skipped`. Applied to all targets.  |
| `transient`         | no           | `false`               | Sets `transient_environment` on created deployments.                               |
| `production`        | no           | `false`               | Sets `production_environment` on created deployments.                              |
| `reuse`             | no           | `true`                | Reuse an existing (`environment`, `ref`, `group`) deployment instead of creating.  |
| `retire`            | no           | `true`                | Mark prior owned deployments in scope `inactive`. Acts only on `finish` `success`. |
| `retire-production` | no           | `false`               | Required to retire `production` deployments.                                       |
| `fail-on-error`     | no           | `true`                | `false` continues across the target list, aggregating errors.                      |

`targets` is the only way to pass environments. No scalar aliases in v0.

## Outputs

| Output        | Shape                                                              |
| ------------- | ------------------------------------------------------------------ |
| `deployments` | JSON string `[{"environment", "url", "deploymentId", "statusId"}]` |
| `retired`     | JSON string of deployment ids marked `inactive`                    |

Both are JSON strings (Actions outputs are strings); consumers use `fromJSON()`.

## Ownership payload

Every deployment created carries:

```json
{ "managed_by": "touchdown", "v": 1, "group": "pr:123" }
```

Scoping rules:

- **Reuse**: match on `environment` + `ref` + `payload.group`, and only if `payload.managed_by === "touchdown"`.
- **Retire** (`finish` success): same `environment` + `payload.group`, `payload.managed_by === "touchdown"`, excluding the current deployment id. Skipped entirely unless `retire-production: true` when the targets being finished are `production`.
- **Deactivate**: same `payload.group` + `payload.managed_by === "touchdown"`, across all environments. It is an explicit, caller-invoked teardown: invoking it with a production-bearing group is itself the opt-in. `ListedDeployment` does not expose `production_environment`, so the action cannot and does not distinguish production in `deactivate`.
- A deployment whose payload is missing, unparseable, or foreign is never touched.
- `v` is the schema version; a breaking payload change bumps it.
- `payload` round-trips as a JSON **object or a JSON string** depending on how it was written. `parseOwnership` must accept both; anything else (missing, non-JSON string, different `managed_by`, mismatched `v`) is foreign and is never touched.

### Lookup contract

`finish` and `deactivate` always find their deployments by re-lookup, never from ids passed by the caller. They list deployments **server-filtered by `environment` only**, then match `ref` + `payload.group` + `managed_by` **client-side**. `ref` is an exact string match on the literal stored at creation (the API never resolves branches↔SHAs and never prefix-matches), so relying on it server-side silently finds nothing when a caller passes a resolved SHA. Filtering by `environment` avoids that trap; the ownership stamp makes the client-side match safe.

`deactivate` lists **without** an environment filter and matches on `payload.group` alone.

The environment filter is **case-insensitive**; `ref`/`task` are exact and case-sensitive.

- Callers never plumb ids between steps, jobs, or runs. `start` and `finish` stay decoupled; teardown-on-PR-close works because it re-discovers via `group`.
- Reuse makes the match deterministic: exactly one current deployment per (`environment`, `ref`, `group`).
- If more than one deployment matches, fail closed with an explicit ambiguity error rather than guessing.
- The production guard keys on the `production` input of the targets being finished, not on the environment name string.

### No post step

v0 has no `runs.post` entrypoint. A post step would have to infer outcome from `job.status`, collapsing `skipped` and per-target nuance — the same context-inference F2 forbids. Callers drive `finish` explicitly. (A warn-only post that detects "start ran, finish never did" is deferred to final.)

## Behavior by mode

### `start`

1. Resolve `ref` and parse/validate inputs. Fail before any API call.
2. For each target:
   - If `reuse` and an owned (`environment`, `ref`, `group`) deployment exists, adopt it.
   - Else create a deployment (`auto_merge: false`, `required_contexts: []`, `transient_environment`, `production_environment`, `payload`).
   - Post an `in_progress` status with `log_url` (run URL) and description, `auto_inactive: false`.
3. Emit `deployments`.

### `finish`

1. Re-lookup prior deployments for each target via the ownership scope (see Lookup contract).
2. Map `status` through the table below; post the terminal status to each target. On `success`, set `environment_url` and `log_url`, truncate the status description to 140.
3. If `retire` and status is `success`, mark owned prior deployments in scope `inactive` (excluding current; production only with `retire-production`).
4. Emit `deployments` and `retired`.

### `deactivate`

1. Re-lookup owned deployments by `payload.group`, listing **all** environments (no filter). This is therefore bounded by the 1,000-deployment cap; past the cap it fails loudly rather than partially deactivating.
2. Post `inactive` to each. Zero matches → no-op, exit 0.
3. Emit `retired`.

## Status mapping

Explicit `status` input is authoritative; nothing is inferred from `steps.*.outcome`.

| `status` input | Deployment status | Result                                            |
| -------------- | ----------------- | ------------------------------------------------- |
| `success`      | `success`         | Terminal, sets `environment_url`, triggers retire |
| `failure`      | `failure`         | Terminal                                          |
| `error`        | `error`           | Terminal                                          |
| `cancelled`    | `error`           | Hardcoded mapping                                 |
| `skipped`      | `error`           | Hardcoded mapping                                 |

The `cancelled`/`skipped` mapping is hardcoded in a pure `statusMap.ts` (no input to override it in v0). Fail-closed: anything unmapped or ambiguous posts `failure`/`error`, never `success`.

## Exit codes

The `status` input never affects the exit code. A `failure`/`error`/`cancelled`/`skipped` status is the action working correctly: the deployment carries the red badge, the step exits 0, and downstream steps still run.

Only action-internal errors fail the step (API failures, validation, ambiguity, pagination cap):

- `fail-on-error: true` (default): stop at the first error and `setFailed` immediately.
- `fail-on-error: false`: attempt every target, still emit `deployments` (successes only) and `retired`, then `setFailed` with every indexed error on its own line (`targets[0]: 422 …`, `targets[2]: …`).

There is no rollback: partial writes stand.

## Validation (reject, don't coerce)

- `environment`: 1–255 chars, non-empty, no control characters (`[\u0000-\u001f\u007f]`), no leading or trailing whitespace. We deliberately do **not** enforce a charset allowlist: GitHub documents none, real environment names contain spaces and Unicode, and safety comes from the ownership stamp, not the name. (`github-pages` is reserved by GitHub Pages; document, do not special-case.)
- `ref` is validated but stored and compared **literally**; the action never resolves it.
- `group`: 1–128 chars, `^[A-Za-z0-9._:/-]+$`.
- `ref`: 40-hex SHA (normalized to lowercase), or safe refname (branch/tag refnames keep their case). Refnames are validated with a denylist: `..`, `~`, `^`, `:`, `?`, `*`, `[`, `@{`, control chars, leading `-`/`/`, and trailing `.` or whitespace are rejected.
- `url` / `logUrl`: empty/absent, or absolute `http(s)` with no userinfo. No network validation.
- `description`: the 140-char limit is on the **deployment status** description. The `description` input is truncated to 140 with a warning when posted as a status; the deployment's own `description` is not constrained (we do not set it).
- Unknown keys in a target object: error.
- Failures happen before any API call, indexed (`targets[1].url: …`).

## API calls

- `POST /repos/{owner}/{repo}/deployments` — create. `task: deploy`, `auto_merge: false`, `required_contexts: []`.
- `POST /repos/{owner}/{repo}/deployments/{id}/statuses` — status. `state`, `description` (≤140), `log_url`, `environment_url`, `auto_inactive: false` (always explicit).
- `GET /repos/{owner}/{repo}/deployments` — list, filtered by `environment` only (never by `ref`; see Lookup contract). `per_page: 100`, follow `Link: rel="next"`, cap at 10 pages (1,000 deployments), error loudly past the cap.
- Repo comes from the run context; same-repo only. No `owner`/`repo` inputs in v0.

The action never calls `listDeploymentStatuses`. The REST Deployment object exposes no current status, so an idempotency check would cost one request per candidate (N+1) and depend on undocumented newest-first ordering. Retire/deactivate simply post `inactive` again; duplicate `inactive` statuses are valid and harmless, which makes idempotency free.

A small in-house retry wrapper (`adapters/retry.ts`) handles `403`/`429` by honoring `retry-after` (seconds), falling back to `x-ratelimit-reset` when `x-ratelimit-remaining: 0`, then a capped exponential backoff for `5xx`/network errors. It **never retries `createDeployment`** (non-idempotent). `@octokit/plugin-retry` is not used: it ignores `Retry-After`, skips `403`, and would add a dependency. Runtime deps stay at 3.

`auto_merge: false` makes the `202 {message}` merge path unreachable, but the adapter still asserts the create response is `201` with an integer `id` and treats anything else as an internal error.

## Status rendering

- `inactive` shows as "destroyed" only when the deployment was created as transient.
- Non-transient `inactive` shows as inactive.
- Retirement uses `inactive` status; deletion (`DELETE`) is not used in v0.

## File layout

```
action.yml
src/
  main.ts            # wire adapters to the app, fail-closed entry
  domain/            # pure, no toolkit/Octokit imports
    config.ts        # input/output types
    errors.ts        # ValidationError, AmbiguityError, DeploymentNotFoundError, PaginationCapError
    validation.ts    # zod schemas, truncate140, ref resolution
    ownership.ts     # stamp/parse/match, payload v bump path
    statusMap.ts     # hardcoded cancelled/skipped -> error
    scope.ts         # reuse match, retire-set (minus current), production guard, pagination cap
  ports/
    deploymentStore.ts   # create / list / setStatus interface
    io.ts                # getInput / setOutput / info / warning / fail
  adapters/
    octokitStore.ts      # only file importing @actions/github; pagination + cap + auto_inactive:false here
    actionsIO.ts         # only file importing @actions/core
    retry.ts             # in-house retry wrapper (honors retry-after / x-ratelimit-reset; never retries createDeployment)
  modes/
    start.ts
    finish.ts
    deactivate.ts
  outputs.ts
__tests__/           # unit, mocked DeploymentStore
__fixtures__/        # push / pull_request / workflow_dispatch / closed payloads
dist/index.js
dist/package.json    # {"type":"module"}
.github/workflows/   # ci, check-dist, optional integration
.github/actionlint.yaml
.github/dependabot.yml
vitest.config.ts  LICENSE  .node-version  .oxfmtrc.json
README.md  package.json  package-lock.json  tsconfig.json
lefthook.yml  .oxlintrc.json
```

Dependency rule: `domain` imports nothing from `adapters` (or the toolkit). `modes` orchestrate domain + ports. Only `adapters` touch `@actions/*` and Octokit. This keeps T1 unit tests on a narrow `DeploymentStore` mock instead of deep Octokit mocks.

## Testing

- **Unit** (mocked `DeploymentStore`): mode dispatch, validation errors before API calls, target parsing, truncation, URL checks, ref resolution per event fixture, pagination, reuse, ownership filtering, ambiguity fail-closed, retire excludes current, production guard, `fail-on-error` true/false paths, exit-code contract (status never fails the step), output shape.
- **Domain tests:** payload parses as object _and_ string; foreign/unparseable payload never selected.
- **Adapter tests:** retry wrapper with a fake clock (403 + `retry-after`, 429 + `x-ratelimit-reset`, 5xx backoff, `createDeployment` never retried); outgoing params always include `auto_merge:false`, `required_contexts:[]`, `auto_inactive:false`, `log_url`.
- **End-to-end (CI, every PR):** a job that runs `uses: ./` with `mode: deactivate`, a throwaway `group: ci-smoke`, `permissions: deployments: write`. Zero matches → no-op, exit 0. This validates `action.yml` end to end, satisfies actionlint's local-action check, and empirically proves the `setFailed`/outputs contract. `action-validator` validates `action.yml` directly (actionlint only checks local actions via a workflow that references `uses: ./`).
- **Integration** (scratch repo, manual/nightly): PR-timeline entry, View-deployment button, retire on second push, deactivate on close, concurrent-group isolation, multi-target. `nektos/act` is YAML smoke only.
- **Lint**: `actionlint` (workflow + `action.yml`), `oxlint`, `oxfmt --check`, `tsc --noEmit`. `lefthook` runs the fast checks pre-commit and the full set pre-push.

## README requirements

- Recipes: constant-env, per-PR-env, multi-app.
- Migration notes from `bobheadxi/deployments`.
- The required `if: ${{ !cancelled() }}` + explicit string-comparison shape for `finish`/`deactivate` (docs warn against bare `always()`):
  - Same job: `status: ${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}`. Consumers compare `steps.<id>.outcome` (not `conclusion`) against a literal string.
  - Cross-job: map `needs.<job>.result` values `cancelled`/`skipped` explicitly on a job with `if: ${{ !cancelled() }}`.
  - Warn explicitly against `||` fallbacks over `steps.*.outcome` (the `"skipped"` truthy bug).
- `pull_request` usage only; warn against combining with `pull_request_target` + checkout.
- **Fork PRs get a read-only `GITHUB_TOKEN`** — touchdown cannot write deployments on fork PRs. Document the consequence and the `pull_request_target` caveat (never combine with checkout).
- Environment names may contain spaces; `github-pages` is reserved.

## Distribution

- Public repo `martinmiglio/touchdown`. Consumers pin `martinmiglio/touchdown@<sha>` in v0.
- No Marketplace listing in v0. Later: branding + category, tag `v1.0.0`, move floating `v1`.
