import { describe, expect, it } from "vitest";
import { runStart } from "../../src/modes/start.js";
import {
  baseConfig,
  GROUP,
  listed,
  mockIO,
  mockStore,
  REF,
  RUN_URL,
  testContext,
} from "./helpers.js";

describe("runStart", () => {
  it("creates a deployment and posts in_progress when absent", async () => {
    const store = mockStore();
    const io = mockIO();
    const config = baseConfig({
      transient: true,
      production: true,
      targets: [
        {
          environment: "preview",
          url: "https://example.com/pr/123",
          logUrl: "https://example.com/logs/1",
          description: "deploying",
        },
      ],
    });
    const result = await runStart(config, testContext(), store, io);

    expect(store.listDeployments).toHaveBeenCalledTimes(1);
    expect(store.listDeployments).toHaveBeenCalledWith({ environment: "preview" });
    expect(store.createDeployment).toHaveBeenCalledTimes(1);
    expect(store.createDeployment).toHaveBeenCalledWith({
      ref: REF,
      environment: "preview",
      payload: { managed_by: "touchdown", v: 1, group: GROUP },
      transientEnvironment: true,
      productionEnvironment: true,
    });
    expect(store.createStatus).toHaveBeenCalledTimes(1);
    expect(store.createStatus).toHaveBeenCalledWith({
      deploymentId: 7,
      state: "in_progress",
      description: "deploying",
      logUrl: "https://example.com/logs/1",
    });
    expect(result).toEqual({
      deployments: [
        {
          environment: "preview",
          url: "https://example.com/pr/123",
          deploymentId: 7,
          statusId: 1007,
        },
      ],
      retired: [],
      errors: [],
    });
  });

  it("defaults log_url to the run URL when the target has none", async () => {
    const store = mockStore();
    const io = mockIO();
    const config = baseConfig({ targets: [{ environment: "preview" }] });
    await runStart(config, testContext(), store, io);
    expect(store.createStatus).toHaveBeenCalledWith({
      deploymentId: 7,
      state: "in_progress",
      description: undefined,
      logUrl: RUN_URL,
    });
  });

  it("reuses the owned deployment without creating when present", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([listed("preview", 42, GROUP)]);
    const config = baseConfig({ targets: [{ environment: "preview" }] });
    const result = await runStart(config, testContext(), store, io);

    expect(store.createDeployment).not.toHaveBeenCalled();
    expect(io.info).toHaveBeenCalledWith("Reusing deployment 42");
    expect(store.createStatus).toHaveBeenCalledWith({
      deploymentId: 42,
      state: "in_progress",
      description: undefined,
      logUrl: RUN_URL,
    });
    expect(result.deployments).toEqual([
      { environment: "preview", url: undefined, deploymentId: 42, statusId: 1042 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("always creates when reuse is false, even with an owned match", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([listed("preview", 42, GROUP)]);
    const config = baseConfig({ reuse: false, targets: [{ environment: "preview" }] });
    await runStart(config, testContext(), store, io);

    expect(store.createDeployment).toHaveBeenCalledTimes(1);
    expect(io.info).not.toHaveBeenCalled();
  });

  it("lists each distinct environment exactly once for multi-target runs", async () => {
    const store = mockStore();
    const io = mockIO();
    const config = baseConfig({
      targets: [{ environment: "preview-a" }, { environment: "preview-b" }],
    });
    const result = await runStart(config, testContext(), store, io);

    expect(store.listDeployments).toHaveBeenCalledTimes(2);
    expect(store.listDeployments).toHaveBeenNthCalledWith(1, { environment: "preview-a" });
    expect(store.listDeployments).toHaveBeenNthCalledWith(2, { environment: "preview-b" });
    expect(store.createDeployment).toHaveBeenCalledTimes(2);
    expect(result.deployments).toHaveLength(2);
    expect(result.errors).toEqual([]);
  });

  it("propagates AmbiguityError and leaves later targets untouched", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([
      listed("preview", 1, GROUP),
      listed("preview", 2, GROUP),
    ]);
    const config = baseConfig({
      targets: [{ environment: "preview" }, { environment: "other" }],
    });
    await expect(runStart(config, testContext(), store, io)).rejects.toThrow(
      /^targets\[0\]: ambiguous deployment lookup/,
    );
    expect(store.listDeployments).toHaveBeenCalledTimes(1);
    expect(store.createDeployment).not.toHaveBeenCalled();
    expect(store.createStatus).not.toHaveBeenCalled();
  });

  it("fail-on-error false continues past a failure with an indexed error", async () => {
    const store = mockStore();
    const io = mockIO();
    store.createDeployment.mockImplementation(async (input) => {
      if (input.environment === "broken") {
        throw new Error("422 boom");
      }
      return { id: 8, environment: input.environment, ref: input.ref, payload: input.payload };
    });
    const config = baseConfig({
      failOnError: false,
      targets: [{ environment: "broken" }, { environment: "fine" }],
    });
    const result = await runStart(config, testContext(), store, io);

    expect(result.errors).toEqual(["targets[0]: 422 boom"]);
    expect(io.warning).toHaveBeenCalledWith("targets[0]: 422 boom");
    expect(result.deployments).toEqual([
      { environment: "fine", url: undefined, deploymentId: 8, statusId: 1008 },
    ]);
    expect(result.retired).toEqual([]);
  });

  it("fail-on-error true rejects on the first error with no partial result", async () => {
    const store = mockStore();
    const io = mockIO();
    store.createDeployment.mockRejectedValue(new Error("500 nope"));
    const config = baseConfig({
      targets: [{ environment: "broken" }, { environment: "fine" }],
    });
    await expect(runStart(config, testContext(), store, io)).rejects.toThrow(
      "targets[0]: 500 nope",
    );
    expect(store.createDeployment).toHaveBeenCalledTimes(1);
  });

  it("warns when the description was truncated (flag set)", async () => {
    const store = mockStore();
    const io = mockIO();
    const config = baseConfig({
      targets: [
        {
          environment: "preview",
          description: "x".repeat(140),
          descriptionTruncated: true,
        },
      ],
    });
    await runStart(config, testContext(), store, io);
    expect(io.warning).toHaveBeenCalledWith(
      'targets[0] ("preview"): description truncated to 140 characters',
    );
  });

  it("does not warn for a 140-char description without the truncation flag", async () => {
    const store = mockStore();
    const io = mockIO();
    const config = baseConfig({
      targets: [{ environment: "preview", description: "x".repeat(140) }],
    });
    await runStart(config, testContext(), store, io);
    expect(io.warning).not.toHaveBeenCalled();
  });

  it("does not warn for short descriptions", async () => {
    const store = mockStore();
    const io = mockIO();
    const config = baseConfig({ targets: [{ environment: "preview", description: "ok" }] });
    await runStart(config, testContext(), store, io);
    expect(io.warning).not.toHaveBeenCalled();
  });
});
