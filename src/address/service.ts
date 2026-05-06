import { callMcpTool } from "../datasources/mcp";
import { readAppEnv } from "../validation/env";
import type { AddressCandidate } from "@brikell/shared";

type SearchAddressOptions = {
  q: string;
  limit?: number;
};

export async function searchAddressCandidates(options: SearchAddressOptions): Promise<AddressCandidate[]> {
  const env = readAppEnv();
  const result = await callMcpTool(
    {
      url: env.DATAFORSYNINGEN_MCP_URL,
      token: env.DATAFORSYNINGEN_MCP_API_TOKEN,
      origin: env.DATAFORSYNINGEN_MCP_ORIGIN,
    },
    "dataforsyningen.search_address_or_place",
    {
      q: options.q,
      type: "adresse",
      limit: options.limit ?? 5,
    },
  );

  return normalizeAddressSearchResult(result);
}

export async function enrichAddressCandidateCoordinates(candidate: AddressCandidate): Promise<AddressCandidate> {
  if (candidate.coordinates) {
    return candidate.coordinateSource ? candidate : { ...candidate, coordinateSource: "selected-candidate" };
  }

  if (isDataforsyningenAutocompleteCandidate(candidate)) {
    return candidate;
  }

  const matches = await searchAddressCandidates({ q: candidate.label, limit: 5 });
  const match = matches.find((candidateMatch) => {
    return candidateMatch.coordinates && isSameAddressCandidate(candidate, candidateMatch);
  });

  if (!match?.coordinates) return candidate;

  return {
    ...candidate,
    coordinates: match.coordinates,
    coordinateSource: "dataforsyningen-enrichment",
  };
}

export function isDataforsyningenAutocompleteCandidate(candidate: AddressCandidate): boolean {
  return candidate.source.provider === "Dataforsyningen" && candidate.source.serviceId === "gsearch";
}

export function normalizeAddressSearchResult(result: unknown): AddressCandidate[] {
  const payload = extractStructuredPayload(result);
  const records = Array.isArray(payload?.candidates) ? payload.candidates : [];
  const meta = isRecord(payload?.meta) ? payload.meta : {};
  const serviceId = stringValue(meta.serviceId);
  const fetchedAt = stringValue(meta.fetchedAt);

  return records.map((record, index) => normalizeCandidate(record, index, serviceId, fetchedAt)).filter(isAddressCandidate);
}

function normalizeCandidate(record: unknown, index: number, serviceId?: string, fetchedAt?: string): AddressCandidate | undefined {
  if (!isRecord(record)) return undefined;
  const properties = isRecord(record.properties) ? record.properties : record;
  const label =
    firstString(
      properties.betegnelse,
      properties.tekst,
      properties.adressebetegnelse,
      properties.visningstekst,
      properties.label,
      properties.navn,
    ) ?? "";
  if (!label.trim()) return undefined;

  const coordinates = extractCoordinates(record, properties);

  return {
    id: firstString(properties.id, properties.adresseId, properties.uuid, properties.href) ?? `candidate-${index}`,
    label,
    street: firstString(properties.vejnavn, properties.vejnavn_tekst, properties.street),
    houseNumber: firstString(properties.husnr, properties.husnummer, properties.houseNumber),
    floor: firstString(properties.etage),
    door: firstString(properties.door, properties.doer),
    postalCode: firstString(properties.postnr, properties.postnummer, properties.postalCode),
    city: firstString(properties.postnrnavn, properties.by, properties.city),
    municipalityCode: firstString(properties.kommunekode, properties.kommuneKode),
    ...(coordinates ? { coordinates, coordinateSource: "selected-candidate" as const } : {}),
    source: {
      provider: "Dataforsyningen",
      ...(serviceId ? { serviceId } : {}),
      ...(fetchedAt ? { fetchedAt } : {}),
    },
  };
}

function extractCoordinates(record: Record<string, unknown>, properties: Record<string, unknown>): AddressCandidate["coordinates"] {
  return (
    coordinatesFromUnknown(getPath(record, "geometry", "coordinates")) ??
    coordinatesFromUnknown(getPath(record, "geometry")) ??
    coordinatesFromUnknown(getPath(properties, "geometry", "coordinates")) ??
    coordinatesFromUnknown(getPath(properties, "geometry")) ??
    coordinatesFromUnknown(getPath(record, "geometri")) ??
    coordinatesFromUnknown(getPath(properties, "geometri")) ??
    coordinatesFromUnknown(getPath(record, "adgangspunkt")) ??
    coordinatesFromUnknown(getPath(properties, "adgangspunkt")) ??
    coordinatesFromUnknown(getPath(record, "vejpunkt")) ??
    coordinatesFromUnknown(getPath(properties, "vejpunkt")) ??
    coordinatesFromXY(record) ??
    coordinatesFromXY(properties)
  );
}

function coordinatesFromUnknown(value: unknown): AddressCandidate["coordinates"] {
  if (Array.isArray(value)) {
    const direct = coordinatesFromPair(value[0], value[1]);
    if (direct) return direct;

    for (const nested of value) {
      const nestedCoordinates = coordinatesFromUnknown(nested);
      if (nestedCoordinates) return nestedCoordinates;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  return (
    coordinatesFromXY(value) ??
    coordinatesFromUnknown(value.coordinates) ??
    coordinatesFromUnknown(value.koordinater) ??
    coordinatesFromUnknown(value.geometry) ??
    coordinatesFromUnknown(value.geometri) ??
    coordinatesFromUnknown(value.punkt) ??
    coordinatesFromUnknown(value.point)
  );
}

function coordinatesFromXY(value: Record<string, unknown>): AddressCandidate["coordinates"] {
  return coordinatesFromPair(value.x, value.y);
}

function coordinatesFromPair(xValue: unknown, yValue: unknown): AddressCandidate["coordinates"] {
  const x = numberValue(xValue);
  const y = numberValue(yValue);
  if (typeof x !== "number" || typeof y !== "number") return undefined;
  if (!isLikelyEpsg25832(x, y)) return undefined;
  return { x, y, srid: "EPSG:25832" };
}

function isLikelyEpsg25832(x: number, y: number): boolean {
  return x >= 100_000 && x <= 1_000_000 && y >= 5_000_000 && y <= 7_000_000;
}

function getPath(value: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isSameAddressCandidate(first: AddressCandidate, second: AddressCandidate): boolean {
  return first.id === second.id || normalizeAddressIdentity(first.label) === normalizeAddressIdentity(second.label);
}

function normalizeAddressIdentity(label: string): string {
  return label
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractStructuredPayload(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result)) return undefined;
  if (isRecord(result.structuredContent)) return result.structuredContent;

  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((block): block is { type: string; text: string } => {
    return isRecord(block) && block.type === "text" && typeof block.text === "string";
  });
  if (!textBlock) return undefined;

  try {
    const parsed = JSON.parse(textBlock.text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAddressCandidate(value: AddressCandidate | undefined): value is AddressCandidate {
  return value !== undefined;
}
