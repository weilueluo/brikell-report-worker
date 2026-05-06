import {
  SupabaseAssignmentStore,
  SupabaseReportArtifactStore,
  SupabaseReportJobStore,
  SupabaseVaultStore,
  type AssignmentStore,
  type ReportArtifactStore,
  type ReportJobStore,
  type VaultStore,
} from "@brikell/shared";
import { readAppEnv } from "../validation/env";
import { getSupabaseAdminClient } from "./supabase-client";

export type AppStores = {
  jobs: ReportJobStore;
  artifacts: ReportArtifactStore;
  assignments: AssignmentStore;
  vault: VaultStore;
};

export function createStores(): AppStores {
  const client = getSupabaseAdminClient();
  return {
    jobs: new SupabaseReportJobStore(client),
    artifacts: new SupabaseReportArtifactStore(client, readAppEnv().SUPABASE_STORAGE_BUCKET),
    assignments: new SupabaseAssignmentStore(client),
    vault: new SupabaseVaultStore(client),
  };
}
