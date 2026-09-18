import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunContext } from "../../src/domain/config.js";
import { ValidationError } from "../../src/domain/errors.js";
import { parseInputs, truncate140 } from "../../src/domain/validation.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "..", "__fixtures__");

interface Fixture {
  name: string;
  eventName: string;
  sha: string;
  headSha?: string;
  runUrl: string;
  raw: Record<string, string | undefined>;
  expected: { ref?: string; issues?: string[]; truncated?: boolean; descriptionLength?: number };
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), "utf8")) as Fixture;
}

function contextOf(fixture: Fixture): RunContext {
  return {
    eventName: fixture.eventName,
    sha: fixture.sha,
    headSha: fixture.headSha,
    runUrl: fixture.runUrl,
    owner: "o",
    repo: "r",
  };
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).issues;
  }
  expect.unreachable("expected ValidationError");
}

describe("parseInputs fixtures", () => {
  it("push resolves context.sha", () => {
    const fixture = loadFixture("push");
    const config = parseInputs({ raw: fixture.raw, context: contextOf(fixture) });
    expect(config.ref).toBe(fixture.expected.ref);
    expect(config.mode).toBe("start");
  });

  it("pull_request prefers headSha over the merge sha", () => {
    const fixture = loadFixture("pull_request");
    const config = parseInputs({ raw: fixture.raw, context: contextOf(fixture) });
    expect(config.ref).toBe(fixture.expected.ref);
    expect(config.ref).toBe(fixture.headSha);
    expect(config.ref).not.toBe(fixture.sha);
  });

  it("workflow_dispatch uses the explicit ref", () => {
    const fixture = loadFixture("workflow_dispatch");
    const config = parseInputs({ raw: fixture.raw, context: contextOf(fixture) });
    expect(config.ref).toBe(fixture.expected.ref);
  });

  it("pull_request_closed deactivate resolves no ref and does not throw", () => {
    const fixture = loadFixture("pull_request_closed");
    const config = parseInputs({ raw: fixture.raw, context: contextOf(fixture) });
    expect(config.mode).toBe("deactivate");
    expect(config.ref).toBeUndefined();
    expect(config.targets).toEqual([]);
  });

  it("deactivate_no_ref does not throw and resolves no ref", () => {
    const fixture = loadFixture("deactivate_no_ref");
    const config = parseInputs({ raw: fixture.raw, context: contextOf(fixture) });
    expect(config.mode).toBe("deactivate");
    expect(config.ref).toBeUndefined();
    expect(config.targets).toEqual([]);
  });

  it("invalid_targets yields the indexed issues", () => {
    const fixture = loadFixture("invalid_targets");
    expect(issuesOf(() => parseInputs({ raw: fixture.raw, context: contextOf(fixture) }))).toEqual(
      fixture.expected.issues,
    );
  });

  it("truncation_140 truncates the description at post time", () => {
    const fixture = loadFixture("truncation_140");
    const config = parseInputs({ raw: fixture.raw, context: contextOf(fixture) });
    expect(config.ref).toBe(fixture.expected.ref);
    expect(config.targets[0]?.description?.length).toBe(fixture.expected.descriptionLength);
    expect(config.targets[0]?.description?.length).toBe(140);
    expect(fixture.expected.truncated).toBe(true);
    expect(config.targets[0]?.descriptionTruncated).toBe(true);
  });

  it("leaves descriptionTruncated undefined for a short description", () => {
    const fixture = loadFixture("push");
    const config = parseInputs({ raw: fixture.raw, context: contextOf(fixture) });
    expect(config.targets[0]?.descriptionTruncated).toBeUndefined();
    const context = contextOf(fixture);
    const short = parseInputs({
      raw: {
        ...fixture.raw,
        targets: '[{"environment":"production","description":"short"}]',
      },
      context,
    });
    expect(short.targets[0]?.description).toBe("short");
    expect(short.targets[0]?.descriptionTruncated).toBeUndefined();
  });
});

describe("parseInputs ref resolution", () => {
  const baseContext: RunContext = {
    eventName: "push",
    sha: "a".repeat(40),
    runUrl: "https://github.com/o/r/actions/runs/1",
    owner: "o",
    repo: "r",
  };
  const startRaw = (extra: Record<string, string | undefined> = {}) => ({
    mode: "start",
    group: "g",
    targets: '[{"environment":"preview"}]',
    ...extra,
  });

  it("explicit ref wins over headSha", () => {
    const explicit = "c".repeat(40);
    const config = parseInputs({
      raw: startRaw({ ref: explicit }),
      context: {
        ...baseContext,
        eventName: "pull_request",
        headSha: "b".repeat(40),
        sha: "merge-sha-is-ignored",
      },
    });
    expect(config.ref).toBe(explicit);
  });

  it("falls back to context.sha outside PR events", () => {
    const config = parseInputs({ raw: startRaw(), context: baseContext });
    expect(config.ref).toBe("a".repeat(40));
  });

  it("deactivate with unresolvable ref does not throw", () => {
    const config = parseInputs({
      raw: { mode: "deactivate", group: "g" },
      context: { ...baseContext, sha: "" },
    });
    expect(config.ref).toBeUndefined();
    expect(config.targets).toEqual([]);
  });
});

describe("parseInputs validation", () => {
  const context: RunContext = {
    eventName: "push",
    sha: "a".repeat(40),
    runUrl: "https://github.com/o/r/actions/runs/1",
    owner: "o",
    repo: "r",
  };
  const okStart = {
    mode: "start",
    group: "prod",
    targets: '[{"environment":"production"}]',
  };

  it("rejects invalid JSON targets", () => {
    expect(
      issuesOf(() => parseInputs({ raw: { ...okStart, targets: "not-json" }, context })),
    ).toEqual(["targets: must be valid JSON"]);
  });

  it("rejects unknown target keys", () => {
    expect(
      issuesOf(() =>
        parseInputs({
          raw: { ...okStart, targets: '[{"environment":"ok","url2":"x"}]' },
          context,
        }),
      ),
    ).toEqual(['targets[0]: unknown key "url2"']);
  });

  it("rejects non-object target items", () => {
    expect(issuesOf(() => parseInputs({ raw: { ...okStart, targets: "[1]" }, context }))).toEqual([
      "targets[0]: must be an object",
    ]);
  });

  it("rejects missing and empty targets on start", () => {
    const { targets: _omit, ...noTargets } = okStart;
    expect(issuesOf(() => parseInputs({ raw: noTargets, context }))).toEqual([
      "targets: must be a non-empty array",
    ]);
    expect(issuesOf(() => parseInputs({ raw: { ...okStart, targets: "[]" }, context }))).toEqual([
      "targets: must be a non-empty array",
    ]);
    expect(
      issuesOf(() => parseInputs({ raw: { ...okStart, targets: '{"a":1}' }, context })),
    ).toEqual(["targets: must be a non-empty array"]);
  });

  it("requires status on finish and validates its value", () => {
    const finish = { mode: "finish", group: "g", targets: '[{"environment":"e"}]' };
    expect(issuesOf(() => parseInputs({ raw: finish, context }))).toEqual([
      "status: must be one of success, failure, error, cancelled, skipped",
    ]);
    expect(issuesOf(() => parseInputs({ raw: { ...finish, status: "bogus" }, context }))).toEqual([
      "status: must be one of success, failure, error, cancelled, skipped",
    ]);
    for (const status of ["success", "failure", "error", "cancelled", "skipped"]) {
      expect(parseInputs({ raw: { ...finish, status }, context }).status).toBe(status);
    }
  });

  it("ignores status, targets, and ref on deactivate", () => {
    const config = parseInputs({
      raw: {
        mode: "deactivate",
        group: "g",
        status: "bogus",
        targets: "not-json",
        ref: "also-bogus~",
      },
      context,
    });
    expect(config.status).toBeUndefined();
    expect(config.targets).toEqual([]);
    expect(config.ref).toBeUndefined();
  });

  it("ignores status on start", () => {
    expect(parseInputs({ raw: { ...okStart, status: "bogus" }, context }).status).toBeUndefined();
  });

  it("rejects bad booleans and applies defaults", () => {
    expect(issuesOf(() => parseInputs({ raw: { ...okStart, transient: "yes" }, context }))).toEqual(
      ['transient: must be "true" or "false"'],
    );
    expect(
      issuesOf(() => parseInputs({ raw: { ...okStart, "fail-on-error": "2" }, context })),
    ).toEqual(['fail-on-error: must be "true" or "false"']);
    const config = parseInputs({ raw: okStart, context });
    expect(config.transient).toBe(false);
    expect(config.production).toBe(false);
    expect(config.reuse).toBe(true);
    expect(config.retire).toBe(true);
    expect(config.retireProduction).toBe(false);
    expect(config.failOnError).toBe(true);
    const flipped = parseInputs({
      raw: {
        ...okStart,
        transient: " TRUE ",
        production: "true",
        reuse: "False",
        retire: "false",
        "retire-production": "true",
        "fail-on-error": "false",
      },
      context,
    });
    expect(flipped.transient).toBe(true);
    expect(flipped.reuse).toBe(false);
    expect(flipped.retireProduction).toBe(true);
    expect(flipped.failOnError).toBe(false);
  });

  it("rejects bad modes and groups", () => {
    expect(issuesOf(() => parseInputs({ raw: { ...okStart, mode: "launch" }, context }))).toEqual([
      "mode: must be one of start, finish, deactivate",
    ]);
    const { mode: _omit, ...noMode } = okStart;
    expect(issuesOf(() => parseInputs({ raw: noMode, context }))).toEqual([
      "mode: must be one of start, finish, deactivate",
    ]);
    for (const group of ["pr:123", "a/b_c.d-e:f", "UPPER lower".replace(" ", "")]) {
      expect(parseInputs({ raw: { ...okStart, group }, context }).group).toBe(group);
    }
    for (const group of ["", "has space", "bang!", "semi;colon", "x".repeat(129)]) {
      expect(issuesOf(() => parseInputs({ raw: { ...okStart, group }, context })).length).toBe(1);
    }
    expect(parseInputs({ raw: { ...okStart, group: "x".repeat(128) }, context }).group).toBe(
      "x".repeat(128),
    );
  });

  it("rejects bad URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "ftp://example.com/x",
      "https://u:p@example.com/",
      "not-a-url",
      "/relative/path",
    ]) {
      expect(
        issuesOf(() =>
          parseInputs({
            raw: { ...okStart, targets: `[{"environment":"e","url":"${url}","logUrl":"${url}"}]` },
            context,
          }),
        ),
      ).toContain("targets[0].url: must be absolute http(s)");
    }
    expect(
      issuesOf(() =>
        parseInputs({
          raw: { ...okStart, targets: '[{"environment":"e","logUrl":"ftp://x/"}]' },
          context,
        }),
      ),
    ).toEqual(["targets[0].logUrl: must be absolute http(s)"]);
    const config = parseInputs({
      raw: {
        ...okStart,
        targets:
          '[{"environment":"e","url":"https://example.com/a","logUrl":"http://example.com/log"}]',
      },
      context,
    });
    expect(config.targets[0]?.url).toBe("https://example.com/a");
  });

  it("validates environments: control chars rejected, spaces accepted, edges rejected", () => {
    expect(
      issuesOf(() =>
        parseInputs({ raw: { ...okStart, targets: '[{"environment":"a\\u0007b"}]' }, context }),
      ),
    ).toEqual([
      "targets[0].environment: must be 1-255 chars with no control characters or leading/trailing whitespace",
    ]);
    expect(
      parseInputs({
        raw: { ...okStart, targets: '[{"environment":"Preview – staging"}]' },
        context,
      }).targets[0]?.environment,
    ).toBe("Preview – staging");
    for (const environment of [" leading", "trailing ", ""]) {
      expect(
        issuesOf(() =>
          parseInputs({
            raw: { ...okStart, targets: `[{"environment":${JSON.stringify(environment)}}]` },
            context,
          }),
        ).length,
      ).toBe(1);
    }
    expect(
      parseInputs({
        raw: { ...okStart, targets: `[{"environment":"${"e".repeat(255)}"}]` },
        context,
      }).targets[0]?.environment.length,
    ).toBe(255);
    expect(
      issuesOf(() =>
        parseInputs({
          raw: { ...okStart, targets: `[{"environment":"${"e".repeat(256)}"}]` },
          context,
        }),
      ).length,
    ).toBe(1);
  });

  it("rejects unsafe refs", () => {
    const bad = [
      "a..b",
      "has~tilde",
      "has^caret",
      "has:colon",
      "has?question",
      "has*star",
      "has[bracket",
      "has@{atbrace",
      "-leading-dash",
      "/leading-slash",
      "trailing-dot.",
      "has space",
      "has\ttab",
    ];
    for (const ref of bad) {
      expect(issuesOf(() => parseInputs({ raw: { ...okStart, ref }, context })).length).toBe(1);
    }
    expect(parseInputs({ raw: { ...okStart, ref: "A".repeat(40) }, context }).ref).toBe(
      "a".repeat(40),
    );
    expect(parseInputs({ raw: { ...okStart, ref: "refs/heads/feature-x" }, context }).ref).toBe(
      "refs/heads/feature-x",
    );
  });

  it("lowercases uppercase 40-hex refs for reuse matching", () => {
    const upper = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    expect(parseInputs({ raw: { ...okStart, ref: upper }, context }).ref).toBe(upper.toLowerCase());
  });

  it("preserves case on non-SHA refnames", () => {
    expect(parseInputs({ raw: { ...okStart, ref: "refs/heads/Feature-X" }, context }).ref).toBe(
      "refs/heads/Feature-X",
    );
    expect(parseInputs({ raw: { ...okStart, ref: "Feature-Branch" }, context }).ref).toBe(
      "Feature-Branch",
    );
  });

  it("rejects duplicate environments with an indexed issue", () => {
    expect(
      issuesOf(() =>
        parseInputs({
          raw: {
            ...okStart,
            targets:
              '[{"environment":"pr-preview"},{"environment":"production"},{"environment":"pr-preview"}]',
          },
          context,
        }),
      ),
    ).toEqual(['targets[2].environment: duplicate environment "pr-preview"']);
  });

  it("rejects non-string descriptions without coercion", () => {
    expect(
      issuesOf(() =>
        parseInputs({
          raw: { ...okStart, targets: '[{"environment":"e","description":7}]' },
          context,
        }),
      ),
    ).toEqual(["targets[0].description: must be a string"]);
  });
});

describe("truncate140", () => {
  it("passes short ASCII through", () => {
    expect(truncate140("hello")).toEqual({ value: "hello", truncated: false });
  });

  it("passes exactly 140 chars through", () => {
    const value = "a".repeat(140);
    expect(truncate140(value)).toEqual({ value, truncated: false });
  });

  it("cuts ASCII at 140", () => {
    const result = truncate140("a".repeat(141));
    expect(result.value).toBe("a".repeat(140));
    expect(result.truncated).toBe(true);
  });

  it("cuts on a code-point boundary with emoji/astral chars", () => {
    const emoji = "😀".repeat(139) + "😀😀";
    const result = truncate140(emoji);
    expect(Array.from(result.value).length).toBe(140);
    expect(result.value).toBe("😀".repeat(140));
    expect(result.truncated).toBe(true);
    const exact = truncate140("😀".repeat(140));
    expect(exact.truncated).toBe(false);
    expect(Array.from(exact.value).length).toBe(140);
  });

  it("handles the empty string", () => {
    expect(truncate140("")).toEqual({ value: "", truncated: false });
  });
});
