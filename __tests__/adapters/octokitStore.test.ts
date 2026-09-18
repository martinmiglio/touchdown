import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaginationCapError } from "../../src/domain/errors.js";
import { createStore, readRunContext } from "../../src/adapters/octokitStore.js";

interface FakeHttpError extends Error {
  status: number;
  response: { headers: Record<string, string> };
}

function httpError(status: number): FakeHttpError {
  const err = new Error(`HTTP ${status}`) as FakeHttpError;
  err.status = status;
  err.response = { headers: {} };
  return err;
}

const githubMocks = vi.hoisted(() => ({
  getOctokitCalls: [] as unknown[][],
  fake: null as unknown,
  contextValue: {} as Record<string, unknown>,
}));

vi.mock("@actions/github", () => ({
  getOctokit: (...args: unknown[]) => {
    githubMocks.getOctokitCalls.push(args);
    return githubMocks.fake;
  },
  get context() {
    return githubMocks.contextValue;
  },
}));

interface Page {
  data: Array<{ id: number; environment: string; ref: string; payload?: unknown }>;
  headers: { link?: string };
}

interface FakeOctokit {
  calls: {
    listParams: unknown[];
    createDeployment: unknown[][];
    createDeploymentStatus: unknown[][];
  };
  rest: {
    repos: {
      listDeployments: unknown;
      createDeployment: ReturnType<typeof vi.fn>;
      createDeploymentStatus: ReturnType<typeof vi.fn>;
    };
  };
  paginate: { iterator: (method: unknown, params: unknown) => AsyncIterable<Page> };
}

function makeFake(opts?: {
  createDeploymentImpl?: (...args: unknown[]) => unknown;
  createDeploymentStatusImpl?: (...args: unknown[]) => unknown;
  pages?: Page[];
}): FakeOctokit {
  const calls = {
    listParams: [] as unknown[],
    createDeployment: [] as unknown[][],
    createDeploymentStatus: [] as unknown[][],
  };
  const createDeployment = vi.fn(async (...args: unknown[]) => {
    calls.createDeployment.push(args);
    return opts?.createDeploymentImpl?.(...args);
  });
  const createDeploymentStatus = vi.fn(async (...args: unknown[]) => {
    calls.createDeploymentStatus.push(args);
    return opts?.createDeploymentStatusImpl?.(...args);
  });
  return {
    calls,
    rest: { repos: { listDeployments: () => {}, createDeployment, createDeploymentStatus } },
    paginate: {
      iterator: (_method: unknown, params: unknown) => {
        calls.listParams.push(params);
        const pages = opts?.pages ?? [];
        return (async function* (): AsyncGenerator<Page> {
          for (const page of pages) yield page;
        })();
      },
    },
  };
}

function page(id: number, next: boolean): Page {
  return {
    data: [{ id, environment: "e", ref: "r", payload: {} }],
    headers: next ? { link: `<https://api.github.com/x?page=${id + 1}>; rel="next"` } : {},
  };
}

const STAMP = { managed_by: "touchdown", v: 1, group: "pr:1" } as const;

beforeEach(() => {
  githubMocks.getOctokitCalls.length = 0;
  githubMocks.fake = null;
  githubMocks.contextValue = {};
});

describe("createStore / createDeployment", () => {
  it("sends exact outgoing params and maps the response", async () => {
    const fake = makeFake({
      createDeploymentImpl: () => ({
        status: 201,
        data: { id: 7, environment: "preview", ref: "abc", payload: STAMP },
      }),
    });
    githubMocks.fake = fake;
    const store = createStore("sekret-token", "o", "r");
    expect(githubMocks.getOctokitCalls).toEqual([["sekret-token"]]);

    const created = await store.createDeployment({
      ref: "abc",
      environment: "preview",
      payload: { ...STAMP },
      transientEnvironment: true,
      productionEnvironment: false,
    });

    expect(fake.calls.createDeployment).toHaveLength(1);
    const params = fake.calls.createDeployment[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      owner: "o",
      repo: "r",
      ref: "abc",
      environment: "preview",
      task: "deploy",
      auto_merge: false,
      transient_environment: true,
      production_environment: false,
    });
    expect(params["required_contexts"]).toEqual([]);
    expect(params["payload"]).toEqual(STAMP);
    expect(params["task"]).toBe("deploy");
    expect(params["auto_merge"]).toBe(false);
    expect("description" in params).toBe(false);
    expect(created).toEqual({ id: 7, environment: "preview", ref: "abc", payload: STAMP });
  });

  it("throws on 202 (merge path)", async () => {
    githubMocks.fake = makeFake({
      createDeploymentImpl: () => ({ status: 202, data: { message: "merged" } }),
    });
    const store = createStore("t", "o", "r");
    await expect(
      store.createDeployment({
        ref: "abc",
        environment: "e",
        payload: { ...STAMP },
        transientEnvironment: false,
        productionEnvironment: false,
      }),
    ).rejects.toThrow(/202/);
  });

  it("throws on 201 without an integer id", async () => {
    githubMocks.fake = makeFake({
      createDeploymentImpl: () => ({ status: 201, data: { id: "x" } }),
    });
    const store = createStore("t", "o", "r");
    await expect(
      store.createDeployment({
        ref: "abc",
        environment: "e",
        payload: { ...STAMP },
        transientEnvironment: false,
        productionEnvironment: false,
      }),
    ).rejects.toThrow(/integer id/);
  });

  it("throws on 201 with a non-string environment", async () => {
    githubMocks.fake = makeFake({
      createDeploymentImpl: () => ({ status: 201, data: { id: 7, environment: 42, ref: "abc" } }),
    });
    const store = createStore("t", "o", "r");
    await expect(
      store.createDeployment({
        ref: "abc",
        environment: "e",
        payload: { ...STAMP },
        transientEnvironment: false,
        productionEnvironment: false,
      }),
    ).rejects.toThrow(/internal error/);
  });

  it("never retries createDeployment: a 500 throws after exactly one call", async () => {
    const fake = makeFake({
      createDeploymentImpl: () => {
        throw httpError(500);
      },
    });
    githubMocks.fake = fake;
    const store = createStore("t", "o", "r");
    await expect(
      store.createDeployment({
        ref: "abc",
        environment: "e",
        payload: { ...STAMP },
        transientEnvironment: false,
        productionEnvironment: false,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fake.calls.createDeployment).toHaveLength(1);
  });
});

describe("createStore / createStatus", () => {
  it("sends exact outgoing params with log_url (never target_url)", async () => {
    const fake = makeFake({
      createDeploymentStatusImpl: () => ({ status: 201, data: { id: 11 } }),
    });
    githubMocks.fake = fake;
    const store = createStore("t", "o", "r");
    const out = await store.createStatus({
      deploymentId: 9,
      state: "in_progress",
      description: "hello",
      logUrl: "https://github.com/o/r/actions/runs/1",
      environmentUrl: "https://example.com/env",
    });
    expect(out).toEqual({ id: 11 });
    expect(fake.calls.createDeploymentStatus).toHaveLength(1);
    const params = fake.calls.createDeploymentStatus[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      owner: "o",
      repo: "r",
      deployment_id: 9,
      state: "in_progress",
      description: "hello",
      log_url: "https://github.com/o/r/actions/runs/1",
      environment_url: "https://example.com/env",
      auto_inactive: false,
    });
    expect(params["auto_inactive"]).toBe(false);
    expect("target_url" in params).toBe(false);
  });

  it("omits description, log_url, and environment_url when undefined", async () => {
    const fake = makeFake({
      createDeploymentStatusImpl: () => ({ status: 201, data: { id: 12 } }),
    });
    githubMocks.fake = fake;
    const store = createStore("t", "o", "r");
    await store.createStatus({ deploymentId: 9, state: "inactive" });
    const params = fake.calls.createDeploymentStatus[0]?.[0] as Record<string, unknown>;
    expect("description" in params).toBe(false);
    expect("log_url" in params).toBe(false);
    expect("environment_url" in params).toBe(false);
    expect("target_url" in params).toBe(false);
    expect(params["auto_inactive"]).toBe(false);
  });

  it("retries createStatus: 500 then 201 succeeds after two calls", async () => {
    const fake = makeFake({
      createDeploymentStatusImpl: (() => {
        let n = 0;
        return () => {
          n += 1;
          if (n === 1) throw httpError(500);
          return { status: 201, data: { id: 13 } };
        };
      })(),
    });
    githubMocks.fake = fake;
    const store = createStore("t", "o", "r");
    const out = await store.createStatus({ deploymentId: 9, state: "success" });
    expect(out).toEqual({ id: 13 });
    expect(fake.calls.createDeploymentStatus).toHaveLength(2);
  });

  it("throws when the status response has no integer id", async () => {
    githubMocks.fake = makeFake({
      createDeploymentStatusImpl: () => ({ status: 201, data: {} }),
    });
    const store = createStore("t", "o", "r");
    await expect(store.createStatus({ deploymentId: 9, state: "success" })).rejects.toThrow(
      /integer id/,
    );
  });
});

describe("createStore / listDeployments", () => {
  it("sends per_page 100 + environment filter, accumulates pages", async () => {
    const fake = makeFake({ pages: [page(1, true), page(2, false)] });
    githubMocks.fake = fake;
    const store = createStore("t", "o", "r");
    const out = await store.listDeployments({ environment: "preview" });
    expect(fake.calls.listParams).toEqual([
      { owner: "o", repo: "r", per_page: 100, environment: "preview" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 1, environment: "e", ref: "r" });
  });

  it("omits the environment key entirely when the filter is undefined", async () => {
    const fake = makeFake({ pages: [page(1, false)] });
    githubMocks.fake = fake;
    const store = createStore("t", "o", "r");
    await store.listDeployments({});
    expect(fake.calls.listParams).toHaveLength(1);
    const params = fake.calls.listParams[0] as Record<string, unknown>;
    expect(params).toEqual({ owner: "o", repo: "r", per_page: 100 });
    expect("environment" in params).toBe(false);
  });

  it('10 pages with rel="next" on the 10th throws PaginationCapError', async () => {
    const pages = Array.from({ length: 10 }, (_, i) => page(i + 1, true));
    githubMocks.fake = makeFake({ pages });
    const store = createStore("t", "o", "r");
    await expect(store.listDeployments({})).rejects.toBeInstanceOf(PaginationCapError);
  });

  it("10 pages with no next link succeeds", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => page(i + 1, i < 9));
    githubMocks.fake = makeFake({ pages });
    const store = createStore("t", "o", "r");
    const out = await store.listDeployments({});
    expect(out).toHaveLength(10);
  });
});

describe("readRunContext", () => {
  beforeEach(() => {
    process.env["GITHUB_SERVER_URL"] = "https://github.com";
    process.env["GITHUB_RUN_ID"] = "42";
  });

  it("maps eventName, sha, headSha, owner/repo, and runUrl", () => {
    githubMocks.contextValue = {
      eventName: "pull_request",
      sha: "merge-sha",
      payload: { pull_request: { head: { sha: "head-sha" } } },
      repo: { owner: "o", repo: "r" },
    };
    expect(readRunContext()).toEqual({
      eventName: "pull_request",
      sha: "merge-sha",
      headSha: "head-sha",
      runUrl: "https://github.com/o/r/actions/runs/42",
      owner: "o",
      repo: "r",
    });
  });

  it("leaves headSha undefined when there is no pull_request payload", () => {
    githubMocks.contextValue = {
      eventName: "push",
      sha: "abc",
      payload: {},
      repo: { owner: "o", repo: "r" },
    };
    const ctx = readRunContext();
    expect(ctx.headSha).toBeUndefined();
    expect(ctx.runUrl).toBe("https://github.com/o/r/actions/runs/42");
  });
});
