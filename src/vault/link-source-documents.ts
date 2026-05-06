import type { ReportV1 } from "@brikell/shared";
import type { SourceDocument } from "@brikell/shared";
import type { VaultItem } from "@brikell/shared";

/**
 * Recognised conventions for linking a `sourceDocuments[].id` to a Vault item:
 *
 *   - `vault:<vault-item-id>`  — direct reference. Resolves if any vault item has the matching id.
 *   - `mcp:<source>:<upstreamId>` — provenance reference. Resolves to the `mcp_tool_result`
 *     vault item whose `metadata.dataSources` contains `<source>` and `metadata.upstreamIds`
 *     contains `<upstreamId>`. This is the canonical agent-emitted form.
 *   - `mcp:<provider>.<tool>[:<index>]` — legacy MCP tool-call key. Resolves to the matching
 *     `mcp_tool_result` vault item by `metadata.provider` + `metadata.toolName` (and
 *     `metadata.index` when provided). Kept for backward compatibility.
 *
 * Source documents whose id does not match any convention are left unchanged. The helper is
 * pure; the input is not mutated.
 */
export function linkSourceDocumentsToVault(
  report: ReportV1,
  vaultItems: ReadonlyArray<VaultItem>,
): { report: ReportV1; linked: number } {
  if (vaultItems.length === 0) {
    return { report, linked: 0 };
  }
  const byVaultId = new Map<string, VaultItem>();
  const mcpByKey = new Map<string, VaultItem>();
  const byMcpRef = new Map<string, VaultItem>();
  for (const item of vaultItems) {
    byVaultId.set(item.id, item);
    if (item.kind === "mcp_tool_result") {
      const provider = readStringMetadata(item, "provider");
      const toolName = readStringMetadata(item, "toolName");
      const index = readNumberMetadata(item, "index");
      if (provider && toolName) {
        mcpByKey.set(`${provider}.${toolName}`, item);
        if (typeof index === "number") {
          mcpByKey.set(`${provider}.${toolName}:${index}`, item);
        }
      }
      const sources = readStringArrayMetadata(item, "dataSources");
      const upstreamIds = readStringArrayMetadata(item, "upstreamIds");
      for (const source of sources) {
        if (!byMcpRef.has(source)) byMcpRef.set(source, item);
        for (const upstreamId of upstreamIds) {
          byMcpRef.set(`${source}:${upstreamId}`, item);
        }
      }
    }
  }

  let linked = 0;
  const nextDocs: SourceDocument[] = report.sourceDocuments.map((doc) => {
    if (typeof doc.vaultItemId === "string" && doc.vaultItemId.length > 0) return doc;
    const resolved = resolveByConvention(doc.id, byVaultId, byMcpRef, mcpByKey);
    if (!resolved) return doc;
    linked++;
    return { ...doc, vaultItemId: resolved.id };
  });

  if (linked === 0) return { report, linked };
  return { report: { ...report, sourceDocuments: nextDocs }, linked };
}

function resolveByConvention(
  rawId: string,
  byVaultId: Map<string, VaultItem>,
  byMcpRef: Map<string, VaultItem>,
  mcpByKey: Map<string, VaultItem>,
): VaultItem | undefined {
  if (rawId.startsWith("vault:")) {
    return byVaultId.get(rawId.slice("vault:".length));
  }
  if (rawId.startsWith("mcp:")) {
    const tail = rawId.slice("mcp:".length);
    return byMcpRef.get(tail) ?? mcpByKey.get(tail);
  }
  return undefined;
}

function readStringMetadata(item: VaultItem, key: string): string | undefined {
  const raw = item.metadata?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function readNumberMetadata(item: VaultItem, key: string): number | undefined {
  const raw = item.metadata?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function readStringArrayMetadata(item: VaultItem, key: string): string[] {
  const raw = item.metadata?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
