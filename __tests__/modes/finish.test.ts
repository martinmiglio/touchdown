import { describe, expect, it } from "vitest";
import type { FinishStatus } from "../../src/domain/config.js";
import type { DeploymentState } from "../../src/domain/statusMap.js";
import { runFinish } from "../../src/modes/finish.js";
import {
  baseConfig,
  GROUP,
  listed,
  mockIO,
  mockStore,
  OLD_REF,
  REF,
  RUN_URL,
  testContext,
} from "./helpers.js";

const STATUS_CASES: Array<{ input: FinishStatus; state: DeploymentState }> = [
  { input: "success", state: "success" },
  { input: "failure", state: "failure" },
  { input: "error", state: "error" },
  { input: "cancelled", state: "error" },
  { input: "skipped", state: "error" },
];

describe("runFinish", () => {
  it.each(STATUS_CASES)(
    "maps status $input to deployment state $state",
    async ({ input, state }) => {
      const store = mockStore();
      const io = mockIO();
      store.listDeployments.mockResolvedValue([listed("preview", 9, GROUP)]);
      const config = baseConfig({
        mode: "finish",
        status: input,
        targets: [{ environment: "preview", url: "https://example.com" }],
      });
      const result = await runFinish(config, testContext(), store, io);

      expect(store.createStatus).toHaveBeenCalledTimes(1);
      const call = store.createStatus.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect(call["state"]).toBe(state);
      expect(call["deploymentId"]).toBe(9);
      expect(result.deployments).toEqual([
        {
          environment: "preview",
          url: "https://example.com",
          deploymentId: 9,
          statusId: 1009,
        },
      ]);
      // The status input never affects the exit code: terminal states resolve clean.
      expect(result.errors).toEqual([]);
    },
  );

  it("sets environment_url only on success", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([listed("preview", 9, GROUP)]);

    const success = baseConfig({
      mode: "finish",
      status: "success",
      targets: [{ environment: "preview", url: "https://example.com" }],
    });
    await runFinish(success, testContext(), store, io);
    const successCall = store.createStatus.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(successCall["environmentUrl"]).toBe("https://example.com");

    for (const status of ["failure", "error", "cancelled", "skipped"] as const) {
      store.createStatus.mockClear();
      const config = baseConfig({
        mode: "finish",
        status,
        targets: [{ environment: "preview", url: "https://example.com" }],
      });
      await runFinish(config, testContext(), store, io);
      const call = store.createStatus.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect("environmentUrl" in (call ?? {})).toBe(false);
    }
  });

  it("omits environment_url on success when the target has no url", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([listed("preview", 9, GROUP)]);
    const config = baseConfig({
      mode: "finish",
      status: "success",
      targets: [{ environment: "preview" }],
    });
    await runFinish(config, testContext(), store, io);
    const call = store.createStatus.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect("environmentUrl" in (call ?? {})).toBe(false);
  });

  it("sets log_url on terminal statuses, defaulting to the run URL", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([listed("preview", 9, GROUP)]);
    const config = baseConfig({
      mode: "finish",
      status: "failure",
      targets: [{ environment: "preview", logUrl: "https://example.com/logs/9" }],
    });
    await runFinish(config, testContext(), store, io);
    expect(store.createStatus).toHaveBeenCalledWith({
      deploymentId: 9,
      state: "failure",
      description: undefined,
      logUrl: "https://example.com/logs/9",
    });

    store.createStatus.mockClear();
    const fallback = baseConfig({
      mode: "finish",
      status: "failure",
      targets: [{ environment: "preview" }],
    });
    await runFinish(fallback, testContext(), store, io);
    expect(store.createStatus).toHaveBeenCalledWith({
      deploymentId: 9,
      state: "failure",
      description: undefined,
      logUrl: RUN_URL,
    });
  });

  it("retires prior owned deployments on success, excluding the current id", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([
      listed("preview", 9, GROUP),
      listed("preview", 5, GROUP, OLD_REF),
      listed("preview", 6, GROUP, OLD_REF),
      listed("preview", 50, "other-group"),
    ]);
    const config = baseConfig({
      mode: "finish",
      status: "success",
      targets: [{ environment: "preview" }],
    });
    const result = await runFinish(config, testContext(), store, io);

    // One terminal status + two retirements; the foreign-group deployment is untouched.
    expect(store.createStatus).toHaveBeenCalledTimes(3);
    expect(store.createStatus).toHaveBeenNthCalledWith(1, {
      deploymentId: 9,
      state: "success",
      description: undefined,
      logUrl: RUN_URL,
    });
    expect(store.createStatus).toHaveBeenNthCalledWith(2, {
      deploymentId: 5,
      state: "inactive",
    });
    expect(store.createStatus).toHaveBeenNthCalledWith(3, {
      deploymentId: 6,
      state: "inactive",
    });
    expect(result.retired).toEqual([5, 6]);
    expect(result.errors).toEqual([]);
  });

  it("reuses the listed page for retirement with no extra list call", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([
      listed("preview", 9, GROUP),
      listed("preview", 5, GROUP, OLD_REF),
    ]);
    const config = baseConfig({
      mode: "finish",
      status: "success",
      targets: [{ environment: "preview" }],
    });
    await runFinish(config, testContext(), store, io);
    expect(store.listDeployments).toHaveBeenCalledTimes(1);
    expect(store.listDeployments).toHaveBeenCalledWith({ environment: "preview" });
  });

  it("never retires on non-success statuses", async () => {
    for (const status of ["failure", "error", "cancelled", "skipped"] as const) {
      const store = mockStore();
      const io = mockIO();
      store.listDeployments.mockResolvedValue([
        listed("preview", 9, GROUP),
        listed("preview", 5, GROUP, OLD_REF),
      ]);
      const config = baseConfig({ mode: "finish", status, targets: [{ environment: "preview" }] });
      const result = await runFinish(config, testContext(), store, io);
      expect(store.createStatus).toHaveBeenCalledTimes(1);
      expect(result.retired).toEqual([]);
    }
  });

  it("skips retirement when retire is false", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([
      listed("preview", 9, GROUP),
      listed("preview", 5, GROUP, OLD_REF),
    ]);
    const config = baseConfig({
      mode: "finish",
      status: "success",
      retire: false,
      targets: [{ environment: "preview" }],
    });
    const result = await runFinish(config, testContext(), store, io);
    expect(store.createStatus).toHaveBeenCalledTimes(1);
    expect(result.retired).toEqual([]);
  });

  it("does not retire production without the retire-production opt-in", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([
      listed("prod", 9, GROUP),
      listed("prod", 5, GROUP, OLD_REF),
    ]);
    const config = baseConfig({
      mode: "finish",
      status: "success",
      production: true,
      retireProduction: false,
      targets: [{ environment: "prod" }],
    });
    const result = await runFinish(config, testContext(), store, io);
    expect(store.createStatus).toHaveBeenCalledTimes(1);
    expect(result.retired).toEqual([]);
  });

  it("retires production with the retire-production opt-in", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([
      listed("prod", 9, GROUP),
      listed("prod", 5, GROUP, OLD_REF),
    ]);
    const config = baseConfig({
      mode: "finish",
      status: "success",
      production: true,
      retireProduction: true,
      targets: [{ environment: "prod" }],
    });
    const result = await runFinish(config, testContext(), store, io);
    expect(result.retired).toEqual([5]);
  });

  it("throws DeploymentNotFoundError when start never ran", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([]);
    const config = baseConfig({
      mode: "finish",
      status: "success",
      targets: [{ environment: "preview" }, { environment: "other" }],
    });
    await expect(runFinish(config, testContext(), store, io)).rejects.toThrow(
      `targets[0]: no owned deployment for environment "preview", ref "${REF}", group "${GROUP}" — start may have been skipped`,
    );
    expect(store.listDeployments).toHaveBeenCalledTimes(1);
    expect(store.createStatus).not.toHaveBeenCalled();
  });

  it("fail-on-error false collects the missing deployment and finishes the rest", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockImplementation(async (filter) =>
      filter.environment === "gone"
        ? []
        : [listed("preview", 9, GROUP), listed("preview", 5, GROUP, OLD_REF)],
    );
    const config = baseConfig({
      mode: "finish",
      status: "success",
      failOnError: false,
      targets: [{ environment: "gone" }, { environment: "preview" }],
    });
    const result = await runFinish(config, testContext(), store, io);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^targets\[0\]: no owned deployment/);
    expect(io.warning).toHaveBeenCalledWith(result.errors[0]);
    expect(result.deployments).toEqual([
      { environment: "preview", url: undefined, deploymentId: 9, statusId: 1009 },
    ]);
    expect(result.retired).toEqual([5]);
  });
});
