/** Thrown before any API call. `issues` are indexed, e.g. "targets[1].url: must be absolute http(s)". */
export class ValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`validation failed:\n${issues.join("\n")}`);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Thrown when a uniqueness lookup matches more than one deployment. Fails closed. */
export class AmbiguityError extends Error {
  readonly matches: number[];

  constructor(matches: number[]) {
    super(
      `ambiguous deployment lookup: matched ${matches.length} deployments (${matches.join(", ")})`,
    );
    this.name = "AmbiguityError";
    this.matches = matches;
  }
}

/** Thrown when `finish` cannot find the deployment `start` created. */
export class DeploymentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentNotFoundError";
  }
}

/** Thrown when the bounded pagination cap is exceeded. */
export class PaginationCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaginationCapError";
  }
}
