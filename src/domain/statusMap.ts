import type { FinishStatus } from "./config.js";

export type DeploymentState =
  | "error"
  | "failure"
  | "inactive"
  | "in_progress"
  | "queued"
  | "pending"
  | "success";

function assertNever(value: never): never {
  throw new Error(`unreachable status: ${String(value)}`);
}

/**
 * Hardcoded, not overridable: success->success, failure->failure, error->error,
 * cancelled->error, skipped->error. Total function over FinishStatus.
 */
export function toDeploymentState(status: FinishStatus): DeploymentState {
  switch (status) {
    case "success":
      return "success";
    case "failure":
      return "failure";
    case "error":
      return "error";
    case "cancelled":
      return "error";
    case "skipped":
      return "error";
    default:
      return assertNever(status);
  }
}
