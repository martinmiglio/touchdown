export const MANAGED_BY = "touchdown" as const;
export const PAYLOAD_VERSION = 1 as const;

export interface OwnershipStamp {
  managed_by: typeof MANAGED_BY;
  v: number;
  group: string;
}

/** Payload attached to every deployment we create. */
export function buildPayload(group: string): OwnershipStamp {
  return { managed_by: MANAGED_BY, v: PAYLOAD_VERSION, group };
}

/**
 * Accepts the payload as a JSON object OR a JSON string (the API round-trips both).
 * Returns null for anything missing, malformed, foreign, or version-mismatched.
 * Never throws. Never coerces.
 */
export function parseOwnership(payload: unknown): OwnershipStamp | null {
  let value: unknown = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record["managed_by"] !== MANAGED_BY) {
    return null;
  }
  if (typeof record["v"] !== "number" || record["v"] !== PAYLOAD_VERSION) {
    return null;
  }
  if (typeof record["group"] !== "string" || record["group"].length === 0) {
    return null;
  }
  return { managed_by: MANAGED_BY, v: record["v"], group: record["group"] };
}

/** True iff the payload is ours and, when `group` is given, the group matches. */
export function isOwnedBy(payload: unknown, group?: string): boolean {
  const stamp = parseOwnership(payload);
  if (stamp === null) {
    return false;
  }
  return group === undefined || stamp.group === group;
}
