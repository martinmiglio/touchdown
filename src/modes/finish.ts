import type { Config, RunContext } from "../domain/config.js";
import { DeploymentNotFoundError } from "../domain/errors.js";
import { selectRetireSet, selectReusable } from "../domain/scope.js";
import { toDeploymentState } from "../domain/statusMap.js";
import type { DeploymentStore } from "../ports/deploymentStore.js";
import type { IO } from "../ports/io.js";
import type { RunResult } from "../outputs.js";
import { attempt, warnIfTruncatedDescription } from "./attempt.js";

export async function runFinish(
  config: Config,
  context: RunContext,
  store: DeploymentStore,
  io: IO,
): Promise<RunResult> {
  // parseInputs guarantees status and ref for finish; guard here instead of non-null assertions.
  const statusInput = config.status;
  if (statusInput === undefined) {
    throw new Error("internal: status is required for finish");
  }
  const ref = config.ref;
  if (ref === undefined) {
    throw new Error("internal: ref is required for finish");
  }
  const state = toDeploymentState(statusInput);
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
        // The page fetched here is reused for retirement below — no extra list call.
        const listed = await store.listDeployments({ environment: target.environment });
        const current = selectReusable(listed, {
          environment: target.environment,
          ref,
          group: config.group,
        });
        if (current === undefined) {
          throw new DeploymentNotFoundError(
            `no owned deployment for environment "${target.environment}", ` +
              `ref "${ref}", group "${config.group}" — start may have been skipped, ` +
              `the group/ref may differ between start and finish, ` +
              `or the wrong environment may have been targeted`,
          );
        }
        const status = await store.createStatus({
          deploymentId: current.id,
          state,
          description: target.description,
          logUrl: target.logUrl ?? (context.runUrl || undefined),
          ...(state === "success" && target.url !== undefined
            ? { environmentUrl: target.url }
            : {}),
        });
        const retired: number[] = [];
        if (state === "success" && config.retire) {
          const retireSet = selectRetireSet(listed, {
            environment: target.environment,
            group: config.group,
            currentId: current.id,
            production: config.production,
            retireProduction: config.retireProduction,
          });
          for (const d of retireSet) {
            await store.createStatus({ deploymentId: d.id, state: "inactive" });
            retired.push(d.id);
          }
        }
        return {
          deployment: {
            environment: target.environment,
            url: target.url,
            deploymentId: current.id,
            statusId: status.id,
          },
          retired,
        };
      },
    );
    if (outcome !== undefined) {
      result.deployments.push(outcome.deployment);
      result.retired.push(...outcome.retired);
    }
  }
  return result;
}
