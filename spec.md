# Touchdown — Implementation Spec

Companion to `product.md`. This is the shape of the thing we build.

## Runtime & packaging

- JavaScript action: `runs.using: node24`, `main: dist/index.js`.
- TypeScript source in `src/`, bundled with `@vercel/ncc` to a single committed `dist/index.js` (+ sourcemap).
- Runtime dependencies, exact-pinned: `@actions/core`, `@actions/github` (Octokit), `zod` (v4). Nothing else.
- `package-lock.json` committed; `node_modules` never committed.
- Dev toolchain pinned to Node 24: `oxlint`, `oxfmt`, `tsc`, `actionlint`, `lefthook`. No eslint/prettier.
- Bun is fine for local installs/tests, but no `Bun.*` APIs in `src/`.
- `check-dist` CI rebuilds and fails if `dist/` is stale.

## Inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `mode` | yes | — | `start`, `finish`, or `deactivate`. |
| `group` | yes | — | Lifecycle key, e.g. `pr:123`, `prod`. Correlates reuse/retire/deactivate. |
| `targets` | start/finish | — | JSON array of `{environment, url?, logUrl?, description?}`. |
| `ref` | no | resolved | SHA (40-hex) or safe refname. Defaults per event, see C3. |
| `token` | no | `${{ github.token }}` | Needs `deployments: write`. |
| `status` | finish | — | `success`, `failure`, or `error`. Applied to all targets. |
| `transient` | no | `false` | Sets `transient_environment` on created deployments. |
| `production` | no | `false` | Sets `production_environment` on created deployments. |
| `reuse` | no | `true` | Reuse an existing (`environment`, `ref`, `group`) deployment instead of creating. |
| `retire` | no | `true` | Mark prior owned deployments in scope `inactive`. Acts only on `finish` `success`. |
| `retire-production` | no | `false` | Required to retire `production` deployments. |
| `fail-on-error` | no | `true` | `false` continues across the target list, aggregating errors. |

`targets` is the only way to pass environments. No scalar aliases in v0.

## Outputs

| Output | Shape |
| --- | --- |
| `deployments` | JSON string `[{"environment", "url", "deploymentId", "statusId"}]` |
| `retired` | JSON string of deployment ids marked `inactive` |

Both are JSON strings (Actions outputs are strings); consumers use `fromJSON()`.

## Ownership payload

Every deployment created carries:

```json
{ "managed_by": "touchdown", "v": 1, "group": "pr:123" }
```

Scoping rules:

- **Reuse**: match on `environment` + `ref` + `payload.group`, and only if `payload.managed_by === "touchdown"`.
- **Retire** (`finish` success): same `environment` + `payload.group`, `payload.managed_by === "touchdown"`, excluding the current deployment id. Skipped entirely unless `retire-production: true` when the targets being finished are `production`.
- **Deactivate**: same `payload.group` + `payload.managed_by === "touchdown"`, across all environments.
- A deployment whose payload is missing, unparseable, or foreign is never touched.
- `v` is the schema version; a breaking payload change bumps it.

### Lookup contract

`finish` and `deactivate` always find their deployments by re-lookup, never from ids passed by the caller. They list deployments (server-filtered by `environment`/`ref` where available) and match client-side on the ownership stamp + `group`.

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
2. Map `status` through the table below; post the terminal status to each target. On `success`, set `environment_url` and `log_url`, truncate description to 140.
3. If `retire` and status is `success`, mark owned prior deployments in scope `inactive` (excluding current; production only with `retire-production`).
4. Emit `deployments` and `retired`.

### `deactivate`

1. Re-lookup owned deployments by `payload.group`.
2. Post `inactive` to each. Zero matches → no-op, exit 0.
3. Emit `retired`.

## Status mapping

Explicit `status` input is authoritative; nothing is inferred from `steps.*.outcome`.

| `status` input | Deployment status | Result |
| --- | --- | --- |
| `success` | `success` | Terminal, sets `environment_url`, triggers retire |
| `failure` | `failure` | Terminal |
| `error` | `error` | Terminal |
| `cancelled` | `error` | Hardcoded mapping |
| `skipped` | `error` | Hardcoded mapping |

The `cancelled`/`skipped` mapping is hardcoded in a pure `statusMap.ts` (no input to override it in v0). Fail-closed: anything unmapped or ambiguous posts `failure`/`error`, never `success`.

## Exit codes

The `status` input never affects the exit code. A `failure`/`error`/`cancelled`/`skipped` status is the action working correctly: the deployment carries the red badge, the step exits 0, and downstream steps still run.

Only action-internal errors fail the step (API failures, validation, ambiguity, pagination cap):

- `fail-on-error: true` (default): stop at the first error and `setFailed` immediately.
- `fail-on-error: false`: attempt every target, still emit `deployments` (successes only) and `retired`, then `setFailed` with every indexed error on its own line (`targets[0]: 422 …`, `targets[2]: …`).

There is no rollback: partial writes stand.

## Validation (reject, don't coerce)

- `environment`: 1–255 chars, `^[A-Za-z0-9._/-]+$`.
- `group`: 1–128 chars, `^[A-Za-z0-9._:/-]+$`.
- `ref`: 40-hex SHA, or safe refname `^[A-Za-z0-9._/-]+$` with `..`, `~`, `^`, `:`, `?`, `*`, `[`, control chars, and leading `-`/`/` rejected.
- `url` / `logUrl`: empty/absent, or absolute `http(s)` with no userinfo. No network validation.
- `description`: truncated to 140 chars with a warning (not an error).
- Unknown keys in a target object: error.
- Failures happen before any API call, indexed (`targets[1].url: …`).

## API calls

- `POST /repos/{owner}/{repo}/deployments` — create. `task: deploy`, `auto_merge: false`, `required_contexts: []`.
- `POST /repos/{owner}/{repo}/deployments/{id}/statuses` — status. `state`, `description` (≤140), `log_url`, `environment_url`, `auto_inactive: false` (always explicit).
- `GET /repos/{owner}/{repo}/deployments` — list, filtered by `environment`/`ref`. `per_page: 100`, follow `Link: rel="next"`, cap at 10 pages (1,000 deployments), error loudly past the cap.
- Repo comes from the run context; same-repo only. No `owner`/`repo` inputs in v0.

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
  modes/
    start.ts
    finish.ts
    deactivate.ts
  outputs.ts
__tests__/           # unit, mocked DeploymentStore
__fixtures__/        # push / pull_request / workflow_dispatch / closed payloads
dist/index.js
.github/workflows/   # ci, check-dist
README.md  LICENSE  package.json  package-lock.json  tsconfig.json
lefthook.yml  .oxlintrc.json  actionlint.yml
```

Dependency rule: `domain` imports nothing from `adapters` (or the toolkit). `modes` orchestrate domain + ports. Only `adapters` touch `@actions/*` and Octokit. This keeps T1 unit tests on a narrow `DeploymentStore` mock instead of deep Octokit mocks.

## Testing

- **Unit** (mocked `DeploymentStore`): mode dispatch, validation errors before API calls, target parsing, truncation, URL checks, ref resolution per event fixture, pagination, reuse, ownership filtering, ambiguity fail-closed, retire excludes current, production guard, `fail-on-error` true/false paths, exit-code contract (status never fails the step), output shape.
- **Integration** (scratch repo, manual/nightly): PR-timeline entry, View-deployment button, retire on second push, deactivate on close, concurrent-group isolation, multi-target. `nektos/act` is YAML smoke only.
- **Lint**: `actionlint` (workflow + `action.yml`), `oxlint`, `oxfmt --check`, `tsc --noEmit`. `lefthook` runs the fast checks pre-commit and the full set pre-push.

## README requirements

- Recipes: constant-env, per-PR-env, multi-app.
- Migration notes from `bobheadxi/deployments`.
- The required `if: always()` + explicit string-comparison shape for `finish`/`deactivate`:
  - Same job: `status: ${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}`.
  - Cross-job: `needs.<job>.result` on a job with `if: always()`.
  - Warn explicitly against `||` fallbacks over `steps.*.outcome` (the `"skipped"` truthy bug).
- `pull_request` usage only; warn against combining with `pull_request_target` + checkout.

## Distribution

- Public repo `martinmiglio/touchdown`. Consumers pin `martinmiglio/touchdown@<sha>` in v0.
- No Marketplace listing in v0. Later: branding + category, tag `v1.0.0`, move floating `v1`.
