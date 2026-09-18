import type { OwnershipStamp } from "../domain/ownership.js";
import type { DeploymentState } from "../domain/statusMap.js";
import type { ListedDeployment } from "../domain/scope.js";

/** `environment: undefined` means "all environments" (used by `deactivate`). */
export interface ListFilter {
  environment?: string;
}

export interface CreateDeploymentInput {
  ref: string;
  environment: string;
  payload: OwnershipStamp;
  transientEnvironment: boolean;
  productionEnvironment: boolean;
}

export interface CreatedDeployment {
  id: number;
  environment: string;
  ref: string;
  payload: unknown;
}

export interface CreateStatusInput {
  deploymentId: number;
  state: DeploymentState;
  description?: string; // caller has already truncated to 140
  logUrl?: string;
  environmentUrl?: string; // set only on `success`
}

export interface CreatedStatus {
  id: number;
}

export interface DeploymentStore {
  /** Paginated to PAGE_SIZE, capped at MAX_PAGES. Throws PaginationCapError past the cap. */
  listDeployments(filter: ListFilter): Promise<ListedDeployment[]>;

  /** Adapter MUST send auto_merge:false and required_contexts:[] and assert a 201 with integer id. */
  createDeployment(input: CreateDeploymentInput): Promise<CreatedDeployment>;

  /** Adapter MUST send auto_inactive:false and log_url (not target_url). */
  createStatus(input: CreateStatusInput): Promise<CreatedStatus>;
}
