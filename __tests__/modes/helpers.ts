import { vi } from "vitest";
import type { Config, RunContext } from "../../src/domain/config.js";
import type { ListedDeployment } from "../../src/domain/scope.js";
import type {
  CreateDeploymentInput,
  CreateStatusInput,
  CreatedDeployment,
  CreatedStatus,
  ListFilter,
} from "../../src/ports/deploymentStore.js";

export const REF = "0123456789abcdef0123456789abcdef01234567";
export const OLD_REF = "0000000000000000000000000000000000000000";
export const GROUP = "pr:123";
export const RUN_URL = "https://github.com/o/r/actions/runs/1";
export const TOKEN = "secret-token-123";

export function owned(group: string = GROUP): {
  managed_by: "touchdown";
  v: 1;
  group: string;
} {
  return { managed_by: "touchdown", v: 1, group };
}

export function listed(
  environment: string,
  id: number,
  group: string | null,
  ref: string = REF,
): ListedDeployment {
  return {
    id,
    environment,
    ref,
    payload: group === null ? { foreign: true } : owned(group),
  };
}

export function testContext(): RunContext {
  return { eventName: "push", sha: REF, runUrl: RUN_URL, owner: "o", repo: "r" };
}

export function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    mode: "start",
    group: GROUP,
    targets: [],
    ref: REF,
    transient: false,
    production: false,
    reuse: true,
    retire: true,
    retireProduction: false,
    failOnError: true,
    ...overrides,
  };
}

export function mockIO() {
  return {
    getInput: vi.fn<(name: string, options?: { required?: boolean }) => string>(() => ""),
    setOutput: vi.fn<(name: string, value: string) => void>(() => undefined),
    info: vi.fn<(message: string) => void>(() => undefined),
    warning: vi.fn<(message: string) => void>(() => undefined),
    fail: vi.fn<(message: string) => void>(() => undefined),
    mask: vi.fn<(value: string) => void>(() => undefined),
  };
}

export type MockIO = ReturnType<typeof mockIO>;

export function mockStore() {
  return {
    listDeployments: vi.fn<(filter: ListFilter) => Promise<ListedDeployment[]>>(async () => []),
    createDeployment: vi.fn<(input: CreateDeploymentInput) => Promise<CreatedDeployment>>(
      async (input) => ({
        id: 7,
        environment: input.environment,
        ref: input.ref,
        payload: input.payload,
      }),
    ),
    createStatus: vi.fn<(input: CreateStatusInput) => Promise<CreatedStatus>>(async (input) => ({
      id: 1000 + input.deploymentId,
    })),
  };
}

export type MockStore = ReturnType<typeof mockStore>;
