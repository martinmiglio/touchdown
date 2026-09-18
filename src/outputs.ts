import type { IO } from "./ports/io.js";

export interface DeploymentOutput {
  environment: string;
  url?: string;
  deploymentId: number;
  statusId: number;
}

export interface RunResult {
  deployments: DeploymentOutput[];
  retired: number[];
  /** Indexed, human-readable internal errors. Non-empty => the step must fail after outputs are written. */
  errors: string[];
}

/** Writes `deployments` and `retired` as JSON strings. Never writes `errors` as an output. */
export function writeOutputs(io: IO, result: RunResult): void {
  io.setOutput("deployments", JSON.stringify(result.deployments));
  io.setOutput("retired", JSON.stringify(result.retired));
}
