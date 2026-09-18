# Test fixtures

One JSON object per scenario, shared by unit tests (ref resolution, validation,
truncation) and docs. Shape:

```json
{
  "name": "pull_request",
  "eventName": "pull_request",
  "sha": "<merge sha>",
  "headSha": "<pr head sha>",
  "runUrl": "https://github.com/o/r/actions/runs/1",
  "raw": { "mode": "start", "group": "pr:123", "targets": "[{\"environment\":\"pr-preview\"}]" },
  "expected": { "ref": "<pr head sha>" }
}
```

| Field       | Meaning                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`      | Scenario name; matches the file basename.                                                                                                                                                                                                   |
| `eventName` | `github.context.eventName` for the run.                                                                                                                                                                                                     |
| `sha`       | `github.context.sha` for the run.                                                                                                                                                                                                           |
| `headSha`   | `github.event.pull_request.head.sha`, when present (PR events only). Omitted otherwise.                                                                                                                                                     |
| `runUrl`    | `${serverUrl}/${owner}/${repo}/actions/runs/${runId}` for the run.                                                                                                                                                                          |
| `raw`       | Verbatim action inputs, as passed to `parseInputs({ raw, context })`.                                                                                                                                                                       |
| `expected`  | Scenario-specific expectations: `ref` (resolved literal ref), `issues` (indexed validation errors, `invalid_targets`), `truncated` + `descriptionLength` (`truncation_140`). Empty object for `deactivate` scenarios, which resolve no ref. |

Scenarios: `push`, `pull_request`, `pull_request_closed`, `workflow_dispatch`,
`deactivate_no_ref`, `invalid_targets`, `truncation_140`.
