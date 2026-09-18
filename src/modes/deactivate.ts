import type { Config } from "../domain/config.js";
import { selectDeactivations } from "../domain/scope.js";
import type { DeploymentStore } from "../ports/deploymentStore.js";
import type { IO } from "../ports/io.js";
import type { RunResult } from "../outputs.js";
import { attempt } from "./attempt.js";

export async function runDeactivate(
  config: Config,
  store: DeploymentStore,
  io: IO,
): Promise<RunResult> {
  const result: RunResult = { deployments: [], retired: [], errors: [] };
  // All environments, no filter. Past the page cap the store throws
  // PaginationCapError and we fail loudly rather than partially deactivating.
  const listed = await store.listDeployments({});
  const targets = selectDeactivations(listed, config.group);
  for (let i = 0; i < targets.length; i++) {
    const deployment = targets[i];
    if (deployment === undefined) {
      continue;
    }
    const retired = await attempt(
      `deployment ${deployment.id}`,
      config.failOnError,
      result.errors,
      io,
      async () => {
        await store.createStatus({ deploymentId: deployment.id, state: "inactive" });
        return deployment.id;
      },
    );
    if (retired !== undefined) {
      result.retired.push(retired);
    }
  }
  return result;
}
