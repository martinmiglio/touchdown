import type { Config, RunContext } from "../domain/config.js";
import { buildPayload } from "../domain/ownership.js";
import { selectReusable } from "../domain/scope.js";
import type { DeploymentStore } from "../ports/deploymentStore.js";
import type { IO } from "../ports/io.js";
import type { RunResult } from "../outputs.js";
import { attempt, warnIfTruncatedDescription } from "./attempt.js";

export async function runStart(
  config: Config,
  context: RunContext,
  store: DeploymentStore,
  io: IO,
): Promise<RunResult> {
  // parseInputs guarantees ref for start; guard here instead of a non-null assertion.
  const ref = config.ref;
  if (ref === undefined) {
    throw new Error("internal: ref is required for start");
  }
  const result: RunResult = { deployments: [], retired: [], errors: [] };
  for (let i = 0; i < config.targets.length; i++) {
    const target = config.targets[i];
    if (target === undefined) {
      continue;
    }
    warnIfTruncatedDescription(io, i, target.environment, target.descriptionTruncated);
    const outcome = await attempt(
      `targets[${i}]`,
      config.failOnError,
      result.errors,
      io,
      async () => {
        // One list call per target; environments may differ so nothing is shared.
        const listed = await store.listDeployments({ environment: target.environment });
        let deploymentId: number | undefined;
        if (config.reuse) {
          const existing = selectReusable(listed, {
            environment: target.environment,
            ref,
            group: config.group,
          });
          if (existing !== undefined) {
            deploymentId = existing.id;
            io.info(`Reusing deployment ${existing.id}`);
          }
        }
        if (deploymentId === undefined) {
          const created = await store.createDeployment({
            ref,
            environment: target.environment,
            payload: buildPayload(config.group),
            transientEnvironment: config.transient,
            productionEnvironment: config.production,
          });
          deploymentId = created.id;
        }
        const status = await store.createStatus({
          deploymentId,
          state: "in_progress",
          description: target.description,
          logUrl: target.logUrl ?? (context.runUrl || undefined),
        });
        return {
          environment: target.environment,
          url: target.url,
          deploymentId,
          statusId: status.id,
        };
      },
    );
    if (outcome !== undefined) {
      result.deployments.push(outcome);
    }
  }
  return result;
}
