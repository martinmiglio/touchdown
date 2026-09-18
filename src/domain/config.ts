export type Mode = "start" | "finish" | "deactivate";

/** Caller-supplied terminal status for `finish`. */
export type FinishStatus = "success" | "failure" | "error" | "cancelled" | "skipped";

export interface Target {
  environment: string;
  /** -> status.environment_url on success. Absolute http(s), no userinfo. */
  url?: string;
  /** -> status.log_url. Absolute http(s), no userinfo. */
  logUrl?: string;
  /** Truncated to 140 for the status description. */
  description?: string;
  /** True when `description` was truncated to 140 code points. */
  descriptionTruncated?: boolean;
}

/** Read-only facts from the runner, injected so domain stays pure. */
export interface RunContext {
  eventName: string; // github.context.eventName
  sha: string; // github.context.sha
  headSha?: string; // github.event.pull_request.head.sha, when present
  runUrl: string; // `${serverUrl}/${owner}/${repo}/actions/runs/${runId}`
  owner: string;
  repo: string;
}

export interface Config {
  mode: Mode;
  group: string;
  /** Empty array for `deactivate` (targets are ignored). */
  targets: Target[];
  /** Resolved *literal* ref. `undefined` for `deactivate`. */
  ref?: string;
  status?: FinishStatus; // required iff mode === 'finish'
  transient: boolean; // default false
  production: boolean; // default false
  reuse: boolean; // default true
  retire: boolean; // default true
  retireProduction: boolean; // default false
  failOnError: boolean; // default true
}
