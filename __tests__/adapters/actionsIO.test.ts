import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIO } from "../../src/adapters/actionsIO.js";
import type { IO } from "../../src/ports/io.js";

const coreMocks = vi.hoisted(() => ({
  getInput: vi.fn(),
  setOutput: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock("@actions/core", () => coreMocks);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createIO", () => {
  it("satisfies the IO shape", () => {
    const io: IO = createIO();
    expect(typeof io.getInput).toBe("function");
    expect(typeof io.setOutput).toBe("function");
    expect(typeof io.info).toBe("function");
    expect(typeof io.warning).toBe("function");
    expect(typeof io.fail).toBe("function");
    expect(typeof io.mask).toBe("function");
  });

  it("getInput forwards name and options", () => {
    coreMocks.getInput.mockReturnValue("start");
    const io = createIO();
    const value = io.getInput("mode", { required: true });
    expect(value).toBe("start");
    expect(coreMocks.getInput).toHaveBeenCalledWith("mode", { required: true });
  });

  it("setOutput forwards name and value", () => {
    createIO().setOutput("deployments", "[]");
    expect(coreMocks.setOutput).toHaveBeenCalledWith("deployments", "[]");
  });

  it("info forwards the message", () => {
    createIO().info("hello");
    expect(coreMocks.info).toHaveBeenCalledWith("hello");
  });

  it("warning forwards the message", () => {
    createIO().warning("careful");
    expect(coreMocks.warning).toHaveBeenCalledWith("careful");
  });

  it("fail calls setFailed and never throws", () => {
    expect(() => createIO().fail("boom")).not.toThrow();
    expect(coreMocks.setFailed).toHaveBeenCalledWith("boom");
  });

  it("mask registers the value as a secret", () => {
    createIO().mask("sekret");
    expect(coreMocks.setSecret).toHaveBeenCalledWith("sekret");
  });
});
