import { describe, expect, it } from "vitest";
import type { FinishStatus } from "../../src/domain/config.js";
import { toDeploymentState } from "../../src/domain/statusMap.js";
import type { DeploymentState } from "../../src/domain/statusMap.js";

describe("toDeploymentState", () => {
  it("maps every FinishStatus to its DeploymentState", () => {
    const cases: Array<[FinishStatus, DeploymentState]> = [
      ["success", "success"],
      ["failure", "failure"],
      ["error", "error"],
      ["cancelled", "error"],
      ["skipped", "error"],
    ];
    for (const [input, expected] of cases) {
      expect(toDeploymentState(input)).toBe(expected);
    }
  });

  it("is total over the FinishStatus union (type-level exhaustiveness)", () => {
    // If a member is added to FinishStatus without a mapping, the switch in
    // toDeploymentState fails to compile via assertNever, and this loop (typed
    // over the full union) fails to compile if a member is missing here.
    const all: FinishStatus[] = ["success", "failure", "error", "cancelled", "skipped"];
    const mapped = all.map(toDeploymentState);
    expect(mapped).toEqual(["success", "failure", "error", "error", "error"]);
    expect(mapped.filter((state) => state === "error")).toHaveLength(3);
    expect(all.filter((status) => toDeploymentState(status) === "error")).toEqual([
      "error",
      "cancelled",
      "skipped",
    ]);
    expect(all.filter((status) => toDeploymentState(status) === "success")).toEqual(["success"]);
    expect(all.filter((status) => toDeploymentState(status) === "failure")).toEqual(["failure"]);
    const seen = new Set<DeploymentState>(mapped);
    expect(seen).toEqual(new Set<DeploymentState>(["success", "failure", "error"]));
  });
});
