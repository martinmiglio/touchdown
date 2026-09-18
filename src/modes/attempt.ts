import type { IO } from "../ports/io.js";

/**
 * Runs one per-target unit of work. On error with `failOnError`, throws an
 * indexed `Error` (chaining the original via `cause`) so the mode aborts and
 * `main.ts` fails without outputs. Otherwise records the indexed message,
 * warns, and lets the loop continue.
 */
export async function attempt<T>(
  label: string,
  failOnError: boolean,
  errors: string[],
  io: IO,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const message = `${label}: ${err instanceof Error ? err.message : String(err)}`;
    if (failOnError) {
      throw new Error(message, { cause: err });
    }
    errors.push(message);
    io.warning(message);
    return undefined;
  }
}

/**
 * `parseInputs` truncates descriptions to 140 code points and records it on
 * `target.descriptionTruncated`. Warn once per target, naming the environment.
 */
export function warnIfTruncatedDescription(
  io: IO,
  index: number,
  environment: string,
  descriptionTruncated: boolean | undefined,
): void {
  if (descriptionTruncated === true) {
    io.warning(`targets[${index}] ("${environment}"): description truncated to 140 characters`);
  }
}
