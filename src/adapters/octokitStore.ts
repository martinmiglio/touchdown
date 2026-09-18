import { context, getOctokit } from "@actions/github";
import type { RunContext } from "../domain/config.js";
import { PaginationCapError } from "../domain/errors.js";
import { MAX_PAGES, PAGE_SIZE } from "../domain/scope.js";
import type { ListedDeployment } from "../domain/scope.js";
import type {
  CreateDeploymentInput,
  CreateStatusInput,
  CreatedDeployment,
  CreatedStatus,
  DeploymentStore,
  ListFilter,
} from "../ports/deploymentStore.js";
import { withRetry } from "./retry.js";

type Octokit = ReturnType<typeof getOctokit>;

interface PageLike {
  data: Array<{ id: number; environment: string; ref: string; payload?: unknown }>;
  headers: { link?: string };
}

export function readRunContext(): RunContext {
  const { owner, repo } = context.repo;
  const runUrl =
    `${process.env["GITHUB_SERVER_URL"]}/${owner}/${repo}` +
    `/actions/runs/${process.env["GITHUB_RUN_ID"]}`;
  const headSha = (context.payload as { pull_request?: { head?: { sha?: unknown } } })?.pull_request
    ?.head?.sha;
  return {
    eventName: context.eventName,
    sha: context.sha,
    headSha: typeof headSha === "string" ? headSha : undefined,
    runUrl,
    owner,
    repo,
  };
}

function toListed(row: {
  id?: unknown;
  environment?: unknown;
  ref?: unknown;
  payload?: unknown;
}): ListedDeployment {
  if (
    typeof row.id !== "number" ||
    !Number.isInteger(row.id) ||
    typeof row.environment !== "string" ||
    typeof row.ref !== "string"
  ) {
    throw new Error(
      `internal error: listDeployments returned malformed row: ${JSON.stringify(row)}`,
    );
  }
  return { id: row.id, environment: row.environment, ref: row.ref, payload: row.payload };
}

export function createStore(token: string, owner: string, repo: string): DeploymentStore {
  const octokit: Octokit = getOctokit(token);

  return {
    async listDeployments(filter: ListFilter): Promise<ListedDeployment[]> {
      // Only the network fetch is retried. The cap breach is raised outside
      // withRetry so it fails fast instead of re-listing 10 pages per attempt.
      const params =
        filter.environment !== undefined
          ? { owner, repo, per_page: PAGE_SIZE, environment: filter.environment }
          : { owner, repo, per_page: PAGE_SIZE };
      const { items, capped } = await withRetry(async () => {
        const iterator = octokit.paginate.iterator(
          octokit.rest.repos.listDeployments,
          params,
        ) as unknown as AsyncIterable<PageLike>;
        const out: ListedDeployment[] = [];
        let pages = 0;
        let capped = false;
        for await (const page of iterator) {
          pages += 1;
          for (const row of page.data) out.push(toListed(row));
          if (pages >= MAX_PAGES) {
            capped = /<[^<>]+>;\s*rel="next"/.test(page.headers.link ?? "");
            break;
          }
        }
        return { items: out, capped };
      });
      if (capped) {
        throw new PaginationCapError(
          `listDeployments exceeded the ${MAX_PAGES}-page cap for ` +
            `${owner}/${repo} (environment: ${filter.environment ?? "all"})`,
        );
      }
      return items;
    },

    // Never wrapped in withRetry: non-idempotent, a lost 201 would duplicate the deployment.
    async createDeployment(input: CreateDeploymentInput): Promise<CreatedDeployment> {
      const response = await octokit.rest.repos.createDeployment({
        owner,
        repo,
        ref: input.ref,
        environment: input.environment,
        payload: { ...input.payload } as { [key: string]: unknown },
        task: "deploy",
        auto_merge: false,
        required_contexts: [],
        transient_environment: input.transientEnvironment,
        production_environment: input.productionEnvironment,
      });
      const data = response.data as unknown as {
        id?: unknown;
        environment?: unknown;
        ref?: unknown;
        payload?: unknown;
      };
      if (
        response.status !== 201 ||
        typeof data.id !== "number" ||
        !Number.isInteger(data.id) ||
        typeof data.environment !== "string" ||
        typeof data.ref !== "string"
      ) {
        throw new Error(
          `internal error: createDeployment returned status ${response.status} ` +
            `(expected 201 with integer id): ${JSON.stringify(response.data)}`,
        );
      }
      return {
        id: data.id,
        environment: data.environment,
        ref: data.ref,
        payload: data.payload,
      };
    },

    async createStatus(input: CreateStatusInput): Promise<CreatedStatus> {
      // Only the POST is retried. The id assertion runs outside withRetry so a
      // malformed 201 fails fast instead of re-posting a duplicate status.
      const response = await withRetry(async () =>
        octokit.rest.repos.createDeploymentStatus({
          owner,
          repo,
          deployment_id: input.deploymentId,
          state: input.state,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.logUrl !== undefined ? { log_url: input.logUrl } : {}),
          ...(input.environmentUrl !== undefined ? { environment_url: input.environmentUrl } : {}),
          auto_inactive: false,
        }),
      );
      const id = (response.data as unknown as { id?: unknown })?.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error(
          `internal error: createDeploymentStatus returned no integer id ` +
            `(status ${(response as { status?: unknown }).status}): ${JSON.stringify(response.data)}`,
        );
      }
      return { id };
    },
  };
}
