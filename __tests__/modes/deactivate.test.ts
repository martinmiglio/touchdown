import { describe, expect, it } from "vitest";
import { runDeactivate } from "../../src/modes/deactivate.js";
import { baseConfig, GROUP, listed, mockIO, mockStore } from "./helpers.js";

describe("runDeactivate", () => {
  it("resolves empty with no status calls when nothing matches", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([]);
    const result = await runDeactivate(baseConfig({ mode: "deactivate" }), store, io);

    expect(store.listDeployments).toHaveBeenCalledTimes(1);
    expect(store.listDeployments).toHaveBeenCalledWith({});
    expect(store.createStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ deployments: [], retired: [], errors: [] });
  });

  it("marks every owned match inactive across environments, leaving other groups alone", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([
      listed("preview-a", 1, GROUP),
      listed("preview-b", 2, GROUP),
      listed("preview-a", 3, "other-group"),
      listed("preview-b", 4, null),
    ]);
    const result = await runDeactivate(baseConfig({ mode: "deactivate" }), store, io);

    expect(store.createStatus).toHaveBeenCalledTimes(2);
    expect(store.createStatus).toHaveBeenNthCalledWith(1, {
      deploymentId: 1,
      state: "inactive",
    });
    expect(store.createStatus).toHaveBeenNthCalledWith(2, {
      deploymentId: 2,
      state: "inactive",
    });
    expect(result.retired).toEqual([1, 2]);
    expect(result.errors).toEqual([]);
  });

  it("fail-on-error true rejects on the first failure with later targets untouched", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([listed("a", 1, GROUP), listed("b", 2, GROUP)]);
    store.createStatus.mockRejectedValueOnce(new Error("403 rate limited"));
    await expect(runDeactivate(baseConfig({ mode: "deactivate" }), store, io)).rejects.toThrow(
      "deployment 1: 403 rate limited",
    );
    expect(store.createStatus).toHaveBeenCalledTimes(1);
  });

  it("fail-on-error false collects failures and retires the rest", async () => {
    const store = mockStore();
    const io = mockIO();
    store.listDeployments.mockResolvedValue([listed("a", 1, GROUP), listed("b", 2, GROUP)]);
    store.createStatus.mockImplementation(async (input) => {
      if (input.deploymentId === 1) {
        throw new Error("500 flaky");
      }
      return { id: 2002 };
    });
    const result = await runDeactivate(
      baseConfig({ mode: "deactivate", failOnError: false }),
      store,
      io,
    );

    expect(result.errors).toEqual(["deployment 1: 500 flaky"]);
    expect(io.warning).toHaveBeenCalledWith("deployment 1: 500 flaky");
    expect(result.retired).toEqual([2]);
  });
});
