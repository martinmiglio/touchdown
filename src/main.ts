import { createIO } from "./adapters/actionsIO.js";
import { createStore, readRunContext } from "./adapters/octokitStore.js";
import { parseInputs } from "./domain/validation.js";
import { runDeactivate } from "./modes/deactivate.js";
import { runFinish } from "./modes/finish.js";
import { runStart } from "./modes/start.js";
import { writeOutputs } from "./outputs.js";
import type { RunResult } from "./outputs.js";
import type { IO } from "./ports/io.js";

/** Every action input, read explicitly so renames fail loudly at the call site. */
function readRawInputs(io: IO): Record<string, string | undefined> {
  const names = [
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
  ] as const;
  const raw: Record<string, string | undefined> = {};
  for (const name of names) {
    raw[name] = io.getInput(name);
  }
  return raw;
}

/**
 * Redact the token value wherever it appears, plus `user:pass@` userinfo in
 * URLs. Ordinary http(s) URLs are preserved so error text stays actionable.
 * Defense-in-depth: the runner also auto-masks `core.setSecret` values.
 */
function redact(message: string, token: string): string {
  let out = message;
  if (token !== "") {
    out = out.split(token).join("***");
  }
  return out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s'"]+@/g, "$1***@");
}

export async function run(): Promise<void> {
  let io: IO | undefined;
  let token = "";
  try {
    // createIO() lives inside the try so a construction failure still exits 1
    // via stderr below (no IO exists yet, and console.* is banned in src/**).
    io = createIO();
    token = io.getInput("token", { required: true });
    io.mask(token);
    const context = readRunContext();
    const raw = readRawInputs(io);
    const config = parseInputs({ raw, context });
    const store = createStore(token, context.owner, context.repo);
    let result: RunResult;
    switch (config.mode) {
      case "start":
        result = await runStart(config, context, store, io);
        break;
      case "finish":
        result = await runFinish(config, context, store, io);
        break;
      case "deactivate":
        result = await runDeactivate(config, store, io);
        break;
      default: {
        const never: never = config.mode;
        throw new Error(`unknown mode: ${String(never)}`);
      }
    }
    writeOutputs(io, result);
    if (result.errors.length > 0) {
      io.fail(redact(result.errors.join("\n"), token));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (io !== undefined) {
      io.fail(redact(message, token));
    } else {
      process.exitCode = 1;
      process.stderr.write(`touchdown: failed to initialize action I/O: ${message}\n`);
    }
  }
}
