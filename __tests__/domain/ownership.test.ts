import { describe, expect, it } from "vitest";
import {
  buildPayload,
  isOwnedBy,
  MANAGED_BY,
  parseOwnership,
  PAYLOAD_VERSION,
} from "../../src/domain/ownership.js";

describe("ownership", () => {
  it("exposes the managed_by marker and payload version", () => {
    expect(MANAGED_BY).toBe("touchdown");
    expect(PAYLOAD_VERSION).toBe(1);
  });

  it("buildPayload returns the stamp", () => {
    expect(buildPayload("pr:123")).toEqual({ managed_by: "touchdown", v: 1, group: "pr:123" });
  });

  it("parses an object payload", () => {
    expect(parseOwnership({ managed_by: "touchdown", v: 1, group: "g" })).toEqual({
      managed_by: "touchdown",
      v: 1,
      group: "g",
    });
  });

  it("parses a JSON-string payload", () => {
    expect(parseOwnership('{"managed_by":"touchdown","v":1,"group":"g"}')).toEqual({
      managed_by: "touchdown",
      v: 1,
      group: "g",
    });
  });

  it("ignores extra keys but returns only the stamp", () => {
    expect(parseOwnership({ managed_by: "touchdown", v: 1, group: "g", extra: true })).toEqual({
      managed_by: "touchdown",
      v: 1,
      group: "g",
    });
  });

  it("returns null on managed_by mismatch", () => {
    expect(parseOwnership({ managed_by: "other", v: 1, group: "g" })).toBeNull();
    expect(parseOwnership({ v: 1, group: "g" })).toBeNull();
    expect(parseOwnership('{"managed_by":"other","v":1,"group":"g"}')).toBeNull();
  });

  it("returns null on version mismatch without coercion", () => {
    expect(parseOwnership({ managed_by: "touchdown", v: 2, group: "g" })).toBeNull();
    expect(parseOwnership({ managed_by: "touchdown", v: "1", group: "g" })).toBeNull();
    expect(parseOwnership({ managed_by: "touchdown", group: "g" })).toBeNull();
  });

  it("returns null for a non-JSON string", () => {
    expect(parseOwnership("not-json")).toBeNull();
    expect(parseOwnership("")).toBeNull();
  });

  it("returns null for JSON strings that decode to non-objects", () => {
    expect(parseOwnership("42")).toBeNull();
    expect(parseOwnership("null")).toBeNull();
    expect(parseOwnership('"touchdown"')).toBeNull();
    expect(parseOwnership('[{"managed_by":"touchdown","v":1,"group":"g"}]')).toBeNull();
  });

  it("returns null for null, numbers, and arrays", () => {
    expect(parseOwnership(null)).toBeNull();
    expect(parseOwnership(undefined)).toBeNull();
    expect(parseOwnership(42)).toBeNull();
    expect(parseOwnership([])).toBeNull();
    expect(parseOwnership([{ managed_by: "touchdown", v: 1, group: "g" }])).toBeNull();
  });

  it("returns null for missing or empty group", () => {
    expect(parseOwnership({ managed_by: "touchdown", v: 1 })).toBeNull();
    expect(parseOwnership({ managed_by: "touchdown", v: 1, group: "" })).toBeNull();
    expect(parseOwnership({ managed_by: "touchdown", v: 1, group: 7 })).toBeNull();
  });

  it("isOwnedBy matches without a group filter", () => {
    expect(isOwnedBy({ managed_by: "touchdown", v: 1, group: "g" })).toBe(true);
    expect(isOwnedBy('{"managed_by":"touchdown","v":1,"group":"g"}')).toBe(true);
    expect(isOwnedBy({ managed_by: "other", v: 1, group: "g" })).toBe(false);
    expect(isOwnedBy(null)).toBe(false);
  });

  it("isOwnedBy filters on group hit/miss", () => {
    const payload = { managed_by: "touchdown", v: 1, group: "pr:123" };
    expect(isOwnedBy(payload, "pr:123")).toBe(true);
    expect(isOwnedBy(payload, "pr:456")).toBe(false);
    expect(isOwnedBy('{"managed_by":"touchdown","v":1,"group":"pr:123"}', "pr:123")).toBe(true);
  });
});
