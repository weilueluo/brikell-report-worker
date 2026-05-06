/**
 * Map an MCP tool call (provider × toolName × args) to a public source URL on
 * an allow-listed host, when one can be derived. Returns `null` otherwise.
 *
 * Why this exists:
 * - Vault evidence items today carry the raw tool call but no link to a public
 *   datasource page. Users can't click through to verify.
 * - Captured **at write time** (when `recordMcpToolCallEvidence` runs), not
 *   derived at render time, so payload-shape drift can be caught by tests
 *   instead of silently disappearing the link from the UI.
 * - **Allowlist + redaction**: only HTTPS hosts on a known list produce a URL;
 *   query parameters are filtered to the explicit set this module knows are
 *   safe. Tokens, auth params, session ids are NEVER passed through.
 *
 * V1 coverage:
 * - datafordeler.property.resolve_property + valid BFE → Datafordeler property page
 * - dataforsyningen.search_address_or_place + DAR id → DAR address detail
 * - plandata.get_plan + plan id → Plansystem plan page
 *
 * Tools not listed here return `null`.
 */

const HOST_ALLOWLIST = new Set([
  "datafordeler.dk",
  "dataforsyningen.dk",
  "plandata.dk",
  "kort.plandata.dk",
  "plansystem.dk",
]);

export interface SourceLinkInput {
  provider?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

interface MapperContext {
  args: Record<string, unknown>;
  result: Record<string, unknown> | undefined;
}

type Mapper = (ctx: MapperContext) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MAPPERS: Record<string, Mapper> = {
  // Datafordeler: BFE-based property resolution → public property detail page.
  "datafordeler.property.resolve_property": ({ args, result }) => {
    const bfe =
      readString(args, "bfeNumber") ??
      readString(args, "bfe") ??
      readString(args, "propertyId") ??
      readBfeLookupValue(args) ??
      readString(result ?? {}, "propertyId");
    if (!bfe || !/^\d{1,12}$/.test(bfe)) return null;
    return `https://datafordeler.dk/dataoversigt/ejendomsbeliggenhed/?bfeNumber=${encodeURIComponent(bfe)}`;
  },

  // Dataforsyningen: DAR address detail (when a stable address id is available).
  "dataforsyningen.search_address_or_place": ({ args, result }) => {
    const candidate =
      readString(args, "addressId") ??
      readString(args, "id") ??
      readFirstAddressId(result);
    if (!candidate || !/^[0-9a-f-]{20,40}$/i.test(candidate)) return null;
    return `https://dataforsyningen.dk/data/dar?id=${encodeURIComponent(candidate)}`;
  },

  // Plandata / Plansystem: per-plan public plan page when we have the planID.
  "plandata.get_plan": ({ args }) => {
    const planId = readString(args, "planId") ?? readString(args, "id");
    if (!planId || !/^[0-9a-zA-Z._-]{1,40}$/.test(planId)) return null;
    return `https://plansystem.dk/plansoeg/?planID=${encodeURIComponent(planId)}`;
  },
};

export function mcpEvidenceSourceLink(input: SourceLinkInput): string | null {
  const provider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "";
  const toolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
  if (!provider || !toolName) return null;

  // The bridge sometimes prefixes tool names with the provider (e.g.
  // "datafordeler_property.resolve_property" or "datafordeler.property.resolve_property"
  // for tools like `property.resolve_property`). Strip ONLY when the prefix
  // matches the provider, leaving the dot-separated tool name intact.
  let tool = toolName;
  const prefixes = [`${provider}_`, `${provider}.`];
  for (const prefix of prefixes) {
    if (tool.toLowerCase().startsWith(prefix)) {
      tool = tool.slice(prefix.length);
      break;
    }
  }
  const key = `${provider}.${tool}`;

  const mapper = MAPPERS[key];
  if (!mapper) return null;

  const args = isRecord(input.args) ? input.args : {};
  const result = isRecord(input.result) ? input.result : undefined;

  let url: string | null;
  try {
    url = mapper({ args, result });
  } catch {
    return null;
  }
  if (!url) return null;

  return sanitizeUrl(url);
}

/**
 * Defense-in-depth: even if a mapper returns a URL, run it through a final
 * sanity check. Reject if not HTTPS, not on the allowlist, or has an
 * unsafe-looking query parameter.
 */
export function sanitizeUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!HOST_ALLOWLIST.has(host)) return null;

  // Strip any auth/credential query params we did not intend.
  const cleaned = new URL(parsed.toString());
  const blocked = new Set(["token", "api_key", "apikey", "key", "session", "sessionid", "auth", "authorization", "access_token"]);
  for (const key of Array.from(cleaned.searchParams.keys())) {
    if (blocked.has(key.toLowerCase())) cleaned.searchParams.delete(key);
  }
  cleaned.username = "";
  cleaned.password = "";
  cleaned.hash = "";
  return cleaned.toString();
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const raw = obj[key];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function readBfeLookupValue(obj: Record<string, unknown>): string | undefined {
  const input = obj.input;
  if (!isRecord(input) || input.type !== "bfe") return undefined;
  return readString(input, "value");
}

function readFirstAddressId(result: Record<string, unknown> | undefined): string | undefined {
  if (!result) return undefined;
  const candidates = result["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const first = candidates[0];
  if (!isRecord(first)) return undefined;
  return readString(first, "id");
}

/**
 * Test-only: list the supported (provider, tool) keys. Tests use this to
 * lock the surface so adding a new mapper requires updating the snapshot.
 */
export function supportedMcpEvidenceLinkKeys(): readonly string[] {
  return Object.freeze(Object.keys(MAPPERS).slice().sort());
}
