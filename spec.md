# Touchdown — Implementation Spec

Companion to `product.md`. This is the shape of the thing we build.

## Runtime & packaging

- JavaScript action: `runs.using: node24`, `main: dist/index.js`.
- TypeScript source in `src/`, bundled with `@vercel/ncc` to a single committed `dist/index.js` (+ sourcemap).
- Runtime dependencies: `@actions/core` and `@actions/github` (Octokit) only.
- `package-lock.json` committed; `node_modules` never committed.
- Dev toolchain pinned to Node 24. Bun is fine for local installs/tests, but no `Bun.*` APIs in `src/`.
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
| `retire` | no | `true` on `finish` success | Mark prior owned deployments in scope `inactive`. |
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
- **Retire** (`finish` success): same `environment` + `payload.group`, `payload.managed_by === "touchdown"`, excluding the current deployment id. Skipped entirely when `production` unless `retire-production: true`.
- **Deactivate**: same `payload.group` + `payload.managed_by === "touchdown"`, across all environments.
- A deployment whose payload is missing, unparseable, or foreign is never touched.
- `v` is the schema version; a breaking payload change bumps it.

## Behavior by mode

### `start`

1. Resolve `ref` and parse/validate inputs. Fail before any API call.
2. For each target:
   - If `reuse` and an owned (`environment`, `ref`, `group`) deployment exists, adopt it.
   - Else create a deployment (`auto_merge: false`, `required_contexts: []`, `transient_environment`, `production_environment`, `payload`).
   - Post an `in_progress` status with `log_url` (run URL) and description, `auto_inactive: false`.
3. Emit `deployments`.

### `finish`

1. Resolve prior deployments for each target via the ownership scope.
2. Map `status` through the table below; post the terminal status to each target. On `success`, set `environment_url` and `log_url`, truncate description to 140.
3. If `retire` and status is `success`, mark owned prior deployments in scope `inactive` (excluding current; production only with `retire-production`).
4. Emit `deployments` and `retired`.

### `deactivate`

1. Filter owned deployments by `payload.group`.
2. Post `inactive` to each. Zero matches → no-op, exit 0.
3. Emit `retired`.

## Status mapping

Explicit `status` input is authoritative; nothing is inferred from `steps.*.outcome`.

| `status` input | Deployment status | Result |
| --- | --- | --- |
| `success` | `success` | Terminal, sets `environment_url`, triggers retire |
| `failure` | `failure` | Terminal |
| `error` | `error` | Terminal |
| `cancelled` | `error` | Mapped (overridable) |
| `skipped` | `error` | Mapped (overridable) |

Mapping table is documented and overridable. Fail-closed: anything unmapped or ambiguous posts `failure`/`error`, never `success`.

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
  main.ts            # mode dispatch, fail-closed entry
  inputs.ts          # parsing, targets schema, validation, truncation
  github.ts          # Octokit client, paginated list/deploy helpers
  modes/start.ts
  modes/finish.ts
  modes/deactivate.ts
  outputs.ts
__tests__/           # unit, mocked Octokit
__fixtures__/        # push / pull_request / workflow_dispatch / closed payloads
dist/index.js
.github/workflows/   # ci, check-dist
README.md  LICENSE  package.json  package-lock.json  tsconfig.json
eslint.config.*  actionlint.yml
```

## Testing

- **Unit** (mocked Octokit): mode dispatch, validation errors before API calls, target parsing, truncation, URL checks, ref resolution per event fixture, pagination, reuse, ownership filtering, retire excludes current, production guard, fail-on-error paths, output shape.
- **Integration** (scratch repo, manual/nightly): PR-timeline entry, View-deployment button, retire on second push, deactivate on close, concurrent-group isolation, multi-target. `nektos/act` is YAML smoke only.
- **Lint**: `actionlint`, `eslint`, `tsc --noEmit`.

## Distribution

- Public repo `martinmiglio/touchdown`. Consumers pin `martinmiglio/touchdown@<sha>` in v0.
- No Marketplace listing in v0. Later: branding + category, tag `v1.0.0`, move floating `v1`.
