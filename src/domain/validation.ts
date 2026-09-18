import { z } from "zod";
import type { Config, FinishStatus, Mode, RunContext, Target } from "./config.js";
import { ValidationError } from "./errors.js";

export interface ParseInputsArgs {
  raw: Record<string, string | undefined>; // verbatim action inputs
  context: RunContext;
}

/** Truncate to 140 chars on a code-point boundary. Returns the value and whether it was cut. */
export function truncate140(value: string): { value: string; truncated: boolean } {
  const chars = Array.from(value);
  if (chars.length <= 140) {
    return { value, truncated: false };
  }
  return { value: chars.slice(0, 140).join(""), truncated: true };
}

const GROUP_RE = /^[A-Za-z0-9._:/-]+$/;
const GROUP_MAX = 128;
const ENV_MAX = 255;
const SHA_RE = /^[0-9a-fA-F]{40}$/;
// eslint-disable-next-line no-control-regex -- intentional: rejects control chars in environments/refs.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WHITESPACE_RE = /\s/;

function isValidEnvironment(value: string): boolean {
  if (value.length < 1 || value.length > ENV_MAX) {
    return false;
  }
  if (CONTROL_RE.test(value)) {
    return false;
  }
  if (value !== value.trim()) {
    return false;
  }
  return true;
}

function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  return true;
}

function isValidRef(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  if (SHA_RE.test(value)) {
    return true;
  }
  if (CONTROL_RE.test(value)) {
    return false;
  }
  if (WHITESPACE_RE.test(value)) {
    return false;
  }
  if (
    value.includes("..") ||
    value.includes("~") ||
    value.includes("^") ||
    value.includes(":") ||
    value.includes("?") ||
    value.includes("*") ||
    value.includes("[") ||
    value.includes("@{")
  ) {
    return false;
  }
  if (value.startsWith("-") || value.startsWith("/")) {
    return false;
  }
  if (value.endsWith(".")) {
    return false;
  }
  return true;
}

const ModeSchema = z.enum(["start", "finish", "deactivate"], {
  error: "mode: must be one of start, finish, deactivate",
});

const StatusSchema = z.enum(["success", "failure", "error", "cancelled", "skipped"], {
  error: "status: must be one of success, failure, error, cancelled, skipped",
});

const TargetSchema = z.strictObject({
  environment: z
    .unknown()
    .refine((v): v is string => typeof v === "string" && isValidEnvironment(v), {
      error: "must be 1-255 chars with no control characters or leading/trailing whitespace",
    }),
  url: z
    .unknown()
    .optional()
    .refine(
      (v): v is string | undefined =>
        v === undefined || (typeof v === "string" && (v === "" || isAbsoluteHttpUrl(v))),
      {
        error: "must be absolute http(s)",
      },
    ),
  logUrl: z
    .unknown()
    .optional()
    .refine(
      (v): v is string | undefined =>
        v === undefined || (typeof v === "string" && (v === "" || isAbsoluteHttpUrl(v))),
      { error: "must be absolute http(s)" },
    ),
  description: z
    .unknown()
    .optional()
    .refine((v): v is string | undefined => v === undefined || typeof v === "string", {
      error: "must be a string",
    }),
});

function parseBool(
  value: string | undefined,
  name: string,
  fallback: boolean,
  issues: string[],
): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const lowered = value.trim().toLowerCase();
  if (lowered === "true") {
    return true;
  }
  if (lowered === "false") {
    return false;
  }
  issues.push(`${name}: must be "true" or "false"`);
  return fallback;
}

function validateTargetItem(item: unknown, index: number, issues: string[], out: Target[]): void {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    issues.push(`targets[${index}]: must be an object`);
    return;
  }
  const parsed = TargetSchema.safeParse(item);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          issues.push(`targets[${index}]: unknown key "${key}"`);
        }
      } else {
        const path = issue.path.map((seg) => String(seg)).join(".");
        issues.push(`targets[${index}].${path}: ${issue.message}`);
      }
    }
    return;
  }
  const target: Target = { environment: parsed.data.environment };
  if (typeof parsed.data.url === "string" && parsed.data.url !== "") {
    target.url = parsed.data.url;
  }
  if (typeof parsed.data.logUrl === "string" && parsed.data.logUrl !== "") {
    target.logUrl = parsed.data.logUrl;
  }
  if (typeof parsed.data.description === "string") {
    const cut = truncate140(parsed.data.description);
    target.description = cut.value;
    if (cut.truncated) {
      target.descriptionTruncated = true;
    }
  }
  out.push(target);
}

function parseTargets(rawTargets: string | undefined, issues: string[]): Target[] {
  if (rawTargets === undefined || rawTargets.trim() === "") {
    issues.push("targets: must be a non-empty array");
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTargets) as unknown;
  } catch {
    issues.push("targets: must be valid JSON");
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    issues.push("targets: must be a non-empty array");
    return [];
  }
  const out: Target[] = [];
  const seenEnvironments = new Set<string>();
  for (let i = 0; i < parsed.length; i++) {
    const before = out.length;
    validateTargetItem(parsed[i], i, issues, out);
    if (out.length > before) {
      const environment = out[out.length - 1]?.environment;
      if (environment !== undefined) {
        if (seenEnvironments.has(environment)) {
          issues.push(`targets[${i}].environment: duplicate environment "${environment}"`);
        } else {
          seenEnvironments.add(environment);
        }
      }
    }
  }
  return out;
}

function resolveRef(rawRef: string | undefined, context: RunContext): string | undefined {
  if (rawRef !== undefined && rawRef !== "") {
    return rawRef;
  }
  if (
    (context.eventName === "pull_request" || context.eventName === "pull_request_target") &&
    context.headSha !== undefined &&
    context.headSha !== ""
  ) {
    return context.headSha;
  }
  if (context.sha !== "") {
    return context.sha;
  }
  return undefined;
}

/**
 * zod-based. Throws ValidationError with indexed issues. Performs ref resolution
 * and truncate140. Never calls the API.
 */
export function parseInputs(args: ParseInputsArgs): Config {
  const { raw, context } = args;
  const issues: string[] = [];

  let mode: Mode | undefined;
  const modeResult = ModeSchema.safeParse(raw.mode);
  if (modeResult.success) {
    mode = modeResult.data;
  } else {
    issues.push("mode: must be one of start, finish, deactivate");
  }

  const rawGroup = raw.group;
  let group = "";
  if (
    typeof rawGroup === "string" &&
    rawGroup.length >= 1 &&
    rawGroup.length <= GROUP_MAX &&
    GROUP_RE.test(rawGroup)
  ) {
    group = rawGroup;
  } else {
    issues.push("group: must be 1-128 chars matching ^[A-Za-z0-9._:/-]+$");
  }

  const transient = parseBool(raw.transient, "transient", false, issues);
  const production = parseBool(raw.production, "production", false, issues);
  const reuse = parseBool(raw.reuse, "reuse", true, issues);
  const retire = parseBool(raw.retire, "retire", true, issues);
  const retireProduction = parseBool(raw["retire-production"], "retire-production", false, issues);
  const failOnError = parseBool(raw["fail-on-error"], "fail-on-error", true, issues);

  // `deactivate` ignores targets and ref entirely: never error on them.
  let targets: Target[] = [];
  if (mode !== "deactivate") {
    targets = parseTargets(raw.targets, issues);
  }

  let ref: string | undefined;
  if (mode !== "deactivate") {
    const resolved = resolveRef(raw.ref, context);
    if (resolved !== undefined && isValidRef(resolved)) {
      ref = SHA_RE.test(resolved) ? resolved.toLowerCase() : resolved;
    } else {
      issues.push("ref: must be a 40-char SHA or a valid ref name");
    }
  }

  let status: FinishStatus | undefined;
  if (mode === "finish") {
    const statusResult = StatusSchema.safeParse(raw.status);
    if (statusResult.success) {
      status = statusResult.data;
    } else {
      issues.push("status: must be one of success, failure, error, cancelled, skipped");
    }
  }

  if (mode === undefined || issues.length > 0) {
    throw new ValidationError(issues);
  }
  return {
    mode,
    group,
    targets,
    ref,
    status,
    transient,
    production,
    reuse,
    retire,
    retireProduction,
    failOnError,
  };
}
