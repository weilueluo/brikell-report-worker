import type { AddressCandidate } from "@brikell/shared";
import type { UploadedVaultDoc } from "../vault/uploaded-docs";

const MANAGED_OUTPUT_ROOT = "/mnt/session/outputs";

export function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "report";
}

export function managedOutputDir(jobId: string): string {
  return `${MANAGED_OUTPUT_ROOT}/${safePathSegment(jobId)}`;
}

export function managedOutputPath(jobId: string): string {
  return managedReportMarkdownPath(jobId);
}

export function managedReportMarkdownPath(jobId: string): string {
  return `${managedOutputDir(jobId)}/report.md`;
}

export function managedReportCanonicalPath(jobId: string): string {
  return `${managedOutputDir(jobId)}/report.json`;
}

export interface BuildReportPromptOptions {
  readonly uploadedDocuments?: ReadonlyArray<UploadedVaultDoc>;
}

export function buildReportPrompt(
  jobId: string,
  address: AddressCandidate,
  options: BuildReportPromptOptions = {},
): string {
  const markdownPath = managedReportMarkdownPath(jobId);
  const canonicalPath = managedReportCanonicalPath(jobId);
  const selectedAddressEvidence = describeSelectedAddressEvidence(address);
  const geometry = describeGeometry(address);
  const uploadedSection = describeUploadedDocuments(options.uploadedDocuments ?? []);
  const uploadedInstruction =
    options.uploadedDocuments && options.uploadedDocuments.length > 0
      ? "- When citing one of the uploaded documents listed above, set sourceDocuments[].id to its `vault:<id>` value verbatim and copy the title from the listing. Do this BEFORE inventing your own id."
      : undefined;

  return [
    "Generate a Brikell property intelligence report for a client-facing property audience.",
    "",
    `Confirmed address: ${address.label}`,
    `Job ID: ${jobId}`,
    ...selectedAddressEvidence,
    ...geometry,
    ...uploadedSection,
    "",
    "Use relevant public Danish address, property, building, unit, planning, and document data sources where available.",
    "Use only facts returned by public data sources or explicitly reviewed documents. Do not infer facts that are not present in the evidence.",
    "Write the final report as an external client deliverable, not an implementation log. Do not describe how the report was generated.",
    "Use public data only. Do not include restricted personal, owner, CPR, credential, or private contact data.",
    "If public data is unavailable, incomplete, not reviewed, inconsistent, or uncertain, state that clearly as a limitation instead of guessing.",
    "The confirmed address is already selected by the user. Do not run another Dataforsyningen address/place autocomplete search to confirm or replace it.",
    `Use the selected candidate's exact label for address-text property lookups. If a Datafordeler property tool supports DAR address-id lookup, call it with input.type "dar_address_id" and value "${address.id}".`,
    "If Datafordeler cannot resolve property, BBR, or unit records for the selected candidate, state that the public property registry lookup was not resolved for the confirmed address. Do not say the confirmed address itself was not found.",
    "Choose report sections based on the available evidence and client-facing narrative. Do not force a fixed heading template.",
    "",
    `When the report is finalized, write the final Markdown report to ${markdownPath}. This file is mandatory.`,
    `Also write canonical V1 JSON to ${canonicalPath} whenever you can produce it confidently. This file is optional but strongly preferred. The V1 JSON contract:`,
    "- Top level: { schemaVersion: \"v1\", reportId, generatedAt, subject: { inputAddress, municipality? }, scopeNote?, sections, sourceDocuments }.",
    "- subject.inputAddress must equal the confirmed address above verbatim.",
    "- sections.propertyIdentification has scalar fact fields (bfeNumber, bbrAddress, numberOfGrunde, formerMunicipalPropertyNumber, parcel, parcelArea, waterSupply, drainage) plus additionalFacts.",
    "- sections.buildings, sections.technicalInstallations, sections.residentialUnitGroups, sections.lokalplaner use the list-section shape { availability, items?, reason? } and DO NOT support the \"uncertain\" availability.",
    "- sections.kommuneplan uses { availability, content?, reason? }; only the \"found\" variant carries content.",
    "- Scalar fact fields: { availability: \"found\", value, citations: [...], reviewerNote? } | { availability: \"not_available\" | \"not_reviewed\" | \"not_applicable\" | \"error\", reason?, citations? } | { availability: \"uncertain\", value?, reason?, citations? }.",
    "- Citations must include sourceDocumentId and at least page or locator: { sourceDocumentId, page?, pageEnd?, locator?: { kind, value }, textSpan? }.",
    "- sourceDocuments lists every cited document with { id, type, title, ... }. Every citation's sourceDocumentId must appear in sourceDocuments.",
    "- Every tool response includes `_ref: { source, upstreamId?, fetchedAt }` identifying its upstream data source. When you cite a fact derived from a tool response, set the corresponding `sourceDocuments[].id` to `mcp:<source>:<upstreamId>` (or `mcp:<source>` when no upstreamId is present) using the values from `_ref` verbatim — do not invent ids.",
    ...(uploadedInstruction ? [uploadedInstruction] : []),
    "Complete final evidence, citation, and consistency checks before writing the final files.",
    "The host captures only files written under the output paths above. Do not use alternate final-output paths.",
    `If you cannot produce valid canonical V1 JSON, still write the final Markdown report to ${markdownPath} and skip ${canonicalPath}; the host will fall back to Markdown.`,
  ].join("\n");
}

function describeSelectedAddressEvidence(address: AddressCandidate): string[] {
  const lines = [
    "Selected address evidence:",
    `- Dataforsyningen candidate id: ${address.id}`,
    `- Label: ${address.label}`,
  ];
  if (address.street) lines.push(`- Street: ${address.street}`);
  if (address.houseNumber) lines.push(`- House number: ${address.houseNumber}`);
  if (address.floor) lines.push(`- Floor: ${address.floor}`);
  if (address.door) lines.push(`- Door: ${address.door}`);
  if (address.postalCode) lines.push(`- Postal code: ${address.postalCode}`);
  if (address.city) lines.push(`- City: ${address.city}`);
  if (address.municipalityCode) lines.push(`- Municipality code: ${address.municipalityCode}`);
  if (address.source.serviceId) lines.push(`- Source service: ${address.source.serviceId}`);
  return lines;
}

function describeUploadedDocuments(docs: ReadonlyArray<UploadedVaultDoc>): string[] {
  if (docs.length === 0) return [];
  const lines: string[] = ["", "Uploaded documents already in the Vault for this assignment:"];
  for (const doc of docs) {
    const titleParts = [doc.title];
    if (doc.filename && doc.filename !== doc.title) titleParts.push(`(${doc.filename})`);
    lines.push(`- vault:${doc.vaultItemId} — ${titleParts.join(" ")}`);
  }
  lines.push(
    "When you cite any of these documents, use sourceDocuments[].id = `vault:<id>` from the list (not a local id you invent), and copy the title verbatim.",
  );
  return lines;
}

function describeGeometry(address: AddressCandidate): string[] {
  if (!address.coordinates) {
    return [
      "Address geometry status: unavailable.",
      "Address geometry: no EPSG:25832 coordinates were available for the confirmed candidate.",
    ];
  }

  return [
    `Address geometry status: ${geometrySourceLabel(address.coordinateSource)}.`,
    `Address geometry: EPSG:25832 x=${address.coordinates.x}, y=${address.coordinates.y}.`,
  ];
}

function geometrySourceLabel(source: AddressCandidate["coordinateSource"]): string {
  if (source === "dataforsyningen-enrichment") return "enriched from a matching Dataforsyningen lookup";
  return "from the selected Dataforsyningen candidate";
}
