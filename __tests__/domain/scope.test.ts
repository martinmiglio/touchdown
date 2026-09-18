import { describe, expect, it } from "vitest";
import { AmbiguityError } from "../../src/domain/errors.js";
import { buildPayload } from "../../src/domain/ownership.js";
import {
  MAX_ITEMS,
  MAX_PAGES,
  PAGE_SIZE,
  selectDeactivations,
  selectRetireSet,
  selectReusable,
} from "../../src/domain/scope.js";
import type { ListedDeployment } from "../../src/domain/scope.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function listed(
  id: number,
  environment: string,
  ref: string,
  group: string | null,
  asString = false,
): ListedDeployment {
  const payload =
    group === null ? { managed_by: "foreign", v: 1, group: "x" } : buildPayload(group);
  return {
    id,
    environment,
    ref,
    payload: asString ? JSON.stringify(payload) : payload,
  };
}

describe("scope constants", () => {
  it("pins the pagination bounds", () => {
    expect(PAGE_SIZE).toBe(100);
    expect(MAX_PAGES).toBe(10);
    expect(MAX_ITEMS).toBe(1000);
  });
});

describe("selectReusable", () => {
  it("returns the exact match", () => {
    const rows = [listed(1, "preview", SHA_A, "g"), listed(2, "preview", SHA_B, "g")];
    expect(selectReusable(rows, { environment: "preview", ref: SHA_A, group: "g" })?.id).toBe(1);
  });

  it("returns undefined on ref mismatch (different SHA)", () => {
    const rows = [listed(1, "preview", SHA_A, "g")];
    expect(
      selectReusable(rows, { environment: "preview", ref: SHA_B, group: "g" }),
    ).toBeUndefined();
  });

  it("returns undefined on environment mismatch", () => {
    const rows = [listed(1, "preview", SHA_A, "g")];
    expect(selectReusable(rows, { environment: "other", ref: SHA_A, group: "g" })).toBeUndefined();
  });

  it("ignores foreign payloads", () => {
    const rows = [listed(1, "preview", SHA_A, null)];
    expect(
      selectReusable(rows, { environment: "preview", ref: SHA_A, group: "g" }),
    ).toBeUndefined();
  });

  it("returns undefined on group mismatch", () => {
    const rows = [listed(1, "preview", SHA_A, "other")];
    expect(
      selectReusable(rows, { environment: "preview", ref: SHA_A, group: "g" }),
    ).toBeUndefined();
  });

  it("throws AmbiguityError with matched ids on two matches", () => {
    const rows = [
      listed(1, "preview", SHA_A, "g"),
      listed(2, "preview", SHA_A, "g"),
      listed(3, "preview", SHA_B, "g"),
    ];
    try {
      selectReusable(rows, { environment: "preview", ref: SHA_A, group: "g" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguityError);
      expect((error as AmbiguityError).matches).toEqual([1, 2]);
    }
  });

  it("matches byte-exactly (no case folding or trimming)", () => {
    const rows = [listed(1, "Preview", SHA_A, "g")];
    expect(
      selectReusable(rows, { environment: "preview", ref: SHA_A, group: "g" }),
    ).toBeUndefined();
  });

  it("accepts payloads provided as JSON strings", () => {
    const rows = [listed(1, "preview", SHA_A, "g", true)];
    expect(selectReusable(rows, { environment: "preview", ref: SHA_A, group: "g" })?.id).toBe(1);
  });
});

describe("selectRetireSet", () => {
  const base = { environment: "preview", group: "g", currentId: 9 };

  it("excludes currentId", () => {
    const rows = [listed(9, "preview", SHA_A, "g"), listed(10, "preview", SHA_B, "g")];
    expect(
      selectRetireSet(rows, { ...base, production: false, retireProduction: false }).map(
        (d) => d.id,
      ),
    ).toEqual([10]);
  });

  it("returns [] for production without opt-in", () => {
    const rows = [listed(10, "preview", SHA_B, "g")];
    expect(selectRetireSet(rows, { ...base, production: true, retireProduction: false })).toEqual(
      [],
    );
  });

  it("includes production matches with opt-in", () => {
    const rows = [listed(10, "preview", SHA_B, "g")];
    expect(
      selectRetireSet(rows, { ...base, production: true, retireProduction: true }).map((d) => d.id),
    ).toEqual([10]);
  });

  it("excludes foreign and other-group deployments", () => {
    const rows = [
      listed(10, "preview", SHA_B, null),
      listed(11, "preview", SHA_B, "other"),
      listed(12, "preview", SHA_B, "g"),
    ];
    expect(
      selectRetireSet(rows, { ...base, production: false, retireProduction: false }).map(
        (d) => d.id,
      ),
    ).toEqual([12]);
  });

  it("returns many matches without ambiguity errors", () => {
    const rows = [
      listed(10, "preview", SHA_A, "g"),
      listed(11, "preview", SHA_B, "g"),
      listed(12, "other", SHA_A, "g"),
    ];
    expect(
      selectRetireSet(rows, { ...base, production: false, retireProduction: false }).map(
        (d) => d.id,
      ),
    ).toEqual([10, 11]);
  });

  it("accepts payloads provided as JSON strings", () => {
    const rows = [listed(10, "preview", SHA_B, "g", true)];
    expect(
      selectRetireSet(rows, { ...base, production: false, retireProduction: false }).map(
        (d) => d.id,
      ),
    ).toEqual([10]);
  });
});

describe("selectDeactivations", () => {
  it("matches across environments", () => {
    const rows = [
      listed(1, "preview", SHA_A, "g"),
      listed(2, "production", SHA_A, "g"),
      listed(3, "preview", SHA_A, "other"),
      listed(4, "preview", SHA_A, null),
    ];
    expect(selectDeactivations(rows, "g").map((d) => d.id)).toEqual([1, 2]);
  });

  it("returns [] when nothing is owned", () => {
    expect(selectDeactivations([], "g")).toEqual([]);
    expect(selectDeactivations([listed(1, "preview", SHA_A, "other")], "g")).toEqual([]);
  });

  it("accepts payloads provided as JSON strings", () => {
    const rows = [listed(1, "preview", SHA_A, "g", true)];
    expect(selectDeactivations(rows, "g").map((d) => d.id)).toEqual([1]);
  });
});
