import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIO } from "../../src/adapters/actionsIO.js";
import { createStore, readRunContext } from "../../src/adapters/octokitStore.js";
import { run } from "../../src/main.js";
import { runDeactivate } from "../../src/modes/deactivate.js";
import { runFinish } from "../../src/modes/finish.js";
import { runStart } from "../../src/modes/start.js";
import type { RunResult } from "../../src/outputs.js";
import { GROUP, mockIO, mockStore, REF, RUN_URL, TOKEN } from "./helpers.js";

vi.mock("../../src/adapters/actionsIO.js", () => ({ createIO: vi.fn() }));
vi.mock("../../src/adapters/octokitStore.js", () => ({
  createStore: vi.fn(),
  readRunContext: vi.fn(),
}));
vi.mock("../../src/modes/start.js", () => ({ runStart: vi.fn() }));
vi.mock("../../src/modes/finish.js", () => ({ runFinish: vi.fn() }));
vi.mock("../../src/modes/deactivate.js", () => ({ runDeactivate: vi.fn() }));

const CLEAN_RESULT: RunResult = {
  deployments: [{ environment: "preview", deploymentId: 7, statusId: 1007 }],
  retired: [],
  errors: [],
};

async function loadMain(inputs: Record<string, string>, result: RunResult | Error) {
  const io = mockIO();
  const store = mockStore();
  io.getInput.mockImplementation((name: string) => inputs[name] ?? "");
  vi.mocked(createIO).mockReturnValue(io);
  vi.mocked(readRunContext).mockReturnValue({
    eventName: "push",
    sha: REF,
    runUrl: RUN_URL,
    owner: "o",
    repo: "r",
  });
  vi.mocked(createStore).mockReturnValue(store);
  for (const mode of [runStart, runFinish, runDeactivate]) {
    if (result instanceof Error) {
      vi.mocked(mode).mockRejectedValue(result);
    } else {
      vi.mocked(mode).mockResolvedValue(result);
    }
  }
  await run();
  return { io, store };
}

function startInputs(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    mode: "start",
    group: GROUP,
    targets: JSON.stringify([{ environment: "preview" }]),
    ref: REF,
    token: TOKEN,
    ...overrides,
  };
}

describe("main", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches start, masks the token, writes outputs, and never fails when clean", async () => {
    const { io, store } = await loadMain(startInputs(), CLEAN_RESULT);

    expect(io.mask).toHaveBeenCalledWith(TOKEN);
    expect(io.getInput).toHaveBeenCalledWith("token", { required: true });
    for (const name of [
      "mode",
      "group",
      "targets",
      "ref",
      "status",
      "transient",
      "production",
      "reuse",
      "retire",
      "retire-production",
      "fail-on-error",
    ]) {
      expect(io.getInput).toHaveBeenCalledWith(name);
    }
    expect(createStore).toHaveBeenCalledWith(TOKEN, "o", "r");
    expect(runStart).toHaveBeenCalledTimes(1);
    expect(runStart).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "start", group: GROUP }),
      expect.objectContaining({ owner: "o", repo: "r" }),
      store,
      io,
    );
    expect(runFinish).not.toHaveBeenCalled();
    expect(runDeactivate).not.toHaveBeenCalled();
    expect(io.setOutput).toHaveBeenCalledWith(
      "deployments",
      JSON.stringify(CLEAN_RESULT.deployments),
    );
    expect(io.setOutput).toHaveBeenCalledWith("retired", JSON.stringify([]));
    expect(io.fail).not.toHaveBeenCalled();
  });

  it("dispatches finish and deactivate to the right mode", async () => {
    const finishInputs = {
      ...startInputs({ mode: "finish", status: "success" }),
    };
    const first = await loadMain(finishInputs, CLEAN_RESULT);
    expect(runFinish).toHaveBeenCalledTimes(1);
    expect(runStart).not.toHaveBeenCalled();
    expect(first.io.fail).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const second = await loadMain({ mode: "deactivate", group: GROUP, token: TOKEN }, CLEAN_RESULT);
    expect(runDeactivate).toHaveBeenCalledTimes(1);
    expect(runStart).not.toHaveBeenCalled();
    expect(runFinish).not.toHaveBeenCalled();
    expect(second.io.fail).not.toHaveBeenCalled();
  });

  it("fails once with the joined message when errors are non-empty, after writing outputs", async () => {
    const errors = ["targets[0]: 422 x", "targets[2]: 500 y"];
    const { io } = await loadMain(startInputs(), { ...CLEAN_RESULT, errors });

    expect(io.setOutput).toHaveBeenCalledTimes(2);
    expect(io.fail).toHaveBeenCalledTimes(1);
    expect(io.fail).toHaveBeenCalledWith(errors.join("\n"));
  });

  it("reports validation errors through io.fail with no outputs", async () => {
    const { io } = await loadMain(startInputs({ mode: "bogus" }), CLEAN_RESULT);

    expect(runStart).not.toHaveBeenCalled();
    expect(io.setOutput).not.toHaveBeenCalled();
    expect(io.fail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(io.fail).mock.calls[0]?.[0]).toMatch(/mode:/);
  });

  it("reports a throwing mode through io.fail with no outputs", async () => {
    const { io } = await loadMain(startInputs(), new Error("kaboom"));

    expect(io.setOutput).not.toHaveBeenCalled();
    expect(io.fail).toHaveBeenCalledTimes(1);
    expect(io.fail).toHaveBeenCalledWith("kaboom");
  });

  it("redacts the token from failure messages", async () => {
    const { io } = await loadMain(startInputs(), new Error(`deploy ${TOKEN} failed`));

    expect(io.fail).toHaveBeenCalledTimes(1);
    const message = vi.mocked(io.fail).mock.calls[0]?.[0] as string;
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("***");
  });

  it("preserves ordinary URLs in failure messages while stripping userinfo", async () => {
    const { io } = await loadMain(
      startInputs(),
      new Error("fetch https://example.com/logs/9 failed for https://user:pass@example.com/x"),
    );

    expect(io.fail).toHaveBeenCalledTimes(1);
    const message = vi.mocked(io.fail).mock.calls[0]?.[0] as string;
    expect(message).toContain("https://example.com/logs/9");
    expect(message).not.toContain("user:pass@");
  });
});
