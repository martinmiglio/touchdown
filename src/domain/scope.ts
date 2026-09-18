import { AmbiguityError } from "./errors.js";
import { isOwnedBy } from "./ownership.js";

export const PAGE_SIZE = 100;
export const MAX_PAGES = 10;
export const MAX_ITEMS = PAGE_SIZE * MAX_PAGES; // 1000

export interface ListedDeployment {
  id: number;
  environment: string;
  ref: string;
  payload: unknown;
}

export interface ReuseKey {
  environment: string;
  ref: string;
  group: string;
}

/**
 * Owned matches on environment + literal ref + group (all byte-exact).
 * 0 -> undefined. 1 -> that one. >1 -> throw AmbiguityError.
 */
export function selectReusable(
  listed: readonly ListedDeployment[],
  key: ReuseKey,
): ListedDeployment | undefined {
  const matches = listed.filter(
    (d) =>
      isOwnedBy(d.payload, key.group) && d.environment === key.environment && d.ref === key.ref,
  );
  if (matches.length > 1) {
    throw new AmbiguityError(matches.map((d) => d.id));
  }
  return matches[0];
}

export interface RetireScope {
  environment: string;
  group: string;
  currentId: number;
  production: boolean; // the `production` INPUT of the run being finished
  retireProduction: boolean; // opt-in
}

/**
 * Owned, same environment + group, excluding currentId.
 * Returns [] when production && !retireProduction. Many matches is normal.
 */
export function selectRetireSet(
  listed: readonly ListedDeployment[],
  scope: RetireScope,
): ListedDeployment[] {
  if (scope.production && !scope.retireProduction) {
    return [];
  }
  return listed.filter(
    (d) =>
      d.id !== scope.currentId &&
      d.environment === scope.environment &&
      isOwnedBy(d.payload, scope.group),
  );
}

/** Owned matches on group across all environments. Many matches is normal. */
export function selectDeactivations(
  listed: readonly ListedDeployment[],
  group: string,
): ListedDeployment[] {
  return listed.filter((d) => isOwnedBy(d.payload, group));
}
