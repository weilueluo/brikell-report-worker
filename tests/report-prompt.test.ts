import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReportPrompt } from "../src/agent/prompt";
import type { AddressCandidate } from "@brikell/shared";

test("prompt includes selected-candidate geometry provenance", () => {
  const prompt = buildReportPrompt("job-selected", candidate({ coordinateSource: "selected-candidate" }));

  assert.match(prompt, /Address geometry status: from the selected Dataforsyningen candidate\./);
  assert.match(prompt, /Address geometry: EPSG:25832 x=724000, y=6182000\./);
});

test("prompt treats the selected autocomplete candidate as authoritative", () => {
  const prompt = buildReportPrompt(
    "job-selected-address",
    candidate({
      coordinateSource: "selected-candidate",
      id: "0a3f3d4a-8f4d-4e3b-a977-selected",
      municipalityCode: "0820",
      postalCode: "9640",
      city: "Farsø",
    }),
  );

  assert.match(prompt, /Dataforsyningen candidate id: 0a3f3d4a-8f4d-4e3b-a977-selected/);
  assert.match(prompt, /Municipality code: 0820/);
  assert.match(prompt, /Postal code: 9640/);
  assert.match(prompt, /City: Farsø/);
  assert.match(prompt, /Do not run another Dataforsyningen address\/place autocomplete search/);
  assert.match(prompt, /Use the selected candidate's exact label for address-text property lookups/);
  assert.match(prompt, /input\.type "dar_address_id" and value "0a3f3d4a-8f4d-4e3b-a977-selected"/);
});

test("prompt distinguishes property-registry misses from selected-address misses", () => {
  const prompt = buildReportPrompt("job-property-miss", candidate({ coordinateSource: "selected-candidate" }));

  assert.match(prompt, /public property registry lookup was not resolved for the confirmed address/);
  assert.match(prompt, /Do not say the confirmed address itself was not found/);
});

test("prompt includes enriched geometry provenance", () => {
  const prompt = buildReportPrompt("job-enriched", candidate({ coordinateSource: "dataforsyningen-enrichment" }));

  assert.match(prompt, /Address geometry status: enriched from a matching Dataforsyningen lookup\./);
  assert.match(prompt, /Address geometry: EPSG:25832 x=724000, y=6182000\./);
});

test("prompt includes missing geometry limitation path", () => {
  const prompt = buildReportPrompt("job-missing", {
    id: "frederiksdalsvej-80a",
    label: "Frederiksdalsvej 80A, 2830 Virum",
    source: { provider: "Dataforsyningen", serviceId: "gsearch" },
  });

  assert.match(prompt, /Address geometry status: unavailable\./);
  assert.match(prompt, /no EPSG:25832 coordinates were available/);
  assert.match(prompt, /If public data is unavailable, incomplete, not reviewed, inconsistent, or uncertain/);
});

test("prompt keeps report instructions client-facing and evidence-bound", () => {
  const prompt = buildReportPrompt("job-boundary", candidate({ coordinateSource: "selected-candidate" }));

  assert.match(prompt, /client-facing property audience/);
  assert.match(prompt, /public Danish address, property, building, unit, planning, and document data sources/);
  assert.match(prompt, /Use only facts returned by public data sources or explicitly reviewed documents/);
  assert.match(prompt, /external client deliverable, not an implementation log/);
  assert.match(prompt, /Do not include restricted personal, owner, CPR, credential, or private contact data/);
  assert.match(prompt, /Do not force a fixed heading template/);
  assert.doesNotMatch(prompt, /\bMCP\b|SQL databases|session databases|filesystem caches|output mirrors|exact Markdown headings|Datasource provenance/);
});

test("prompt requests canonical V1 JSON output and describes the schema accurately", () => {
  const prompt = buildReportPrompt("job-canonical", candidate({ coordinateSource: "selected-candidate" }));

  assert.match(prompt, /report\.md/);
  assert.match(prompt, /report\.json/);
  assert.match(prompt, /canonical V1 JSON/);
  assert.match(prompt, /schemaVersion: "v1"/);
  assert.match(prompt, /subject\.inputAddress must equal the confirmed address above verbatim/);
  assert.match(prompt, /sections\.propertyIdentification/);
  assert.match(prompt, /list-section shape \{ availability, items\?, reason\? \}/);
  assert.match(prompt, /DO NOT support the "uncertain" availability/);
  assert.match(prompt, /sections\.kommuneplan uses \{ availability, content\?, reason\? \}/);
  assert.match(prompt, /Citations must include sourceDocumentId/);
  assert.match(prompt, /Every citation's sourceDocumentId must appear in sourceDocuments/);
  assert.match(prompt, /still write the final Markdown report/);
});

test("prompt instructs the agent to write final output files", () => {
  const prompt = buildReportPrompt("job-file-handoff", candidate({ coordinateSource: "selected-candidate" }));

  assert.match(prompt, /write the final Markdown report to .*\/report\.md/);
  assert.match(prompt, /write canonical V1 JSON to .*\/report\.json/);
  assert.match(prompt, /Complete final evidence, citation, and consistency checks before writing the final files/);
  assert.match(prompt, /captures only files written under the output paths above/);
  assert.doesNotMatch(prompt, /custom tool/);
});

test("prompt canonical and Markdown paths share the same sanitized job directory", () => {
  const dirty = "job with spaces/and slashes";
  const prompt = buildReportPrompt(dirty, candidate({ coordinateSource: "selected-candidate" }));
  assert.match(prompt, /\/mnt\/session\/outputs\/[A-Za-z0-9._-]+\/report\.md/);
  assert.match(prompt, /\/mnt\/session\/outputs\/[A-Za-z0-9._-]+\/report\.json/);
  const mdMatch = prompt.match(/\/mnt\/session\/outputs\/([A-Za-z0-9._-]+)\/report\.md/);
  const jsonMatch = prompt.match(/\/mnt\/session\/outputs\/([A-Za-z0-9._-]+)\/report\.json/);
  assert.ok(mdMatch && jsonMatch);
  assert.equal(mdMatch![1], jsonMatch![1]);
});

test("prompt without uploadedDocuments option omits the uploaded-documents section", () => {
  const prompt = buildReportPrompt("job-no-uploads", candidate({ coordinateSource: "selected-candidate" }));
  assert.doesNotMatch(prompt, /Uploaded documents already in the Vault/);
  assert.doesNotMatch(prompt, /vault:/);
});

test("prompt with uploadedDocuments section lists each document with vault:<id> and instruction", () => {
  const prompt = buildReportPrompt(
    "job-uploads",
    candidate({ coordinateSource: "selected-candidate" }),
    {
      uploadedDocuments: [
        {
          vaultItemId: "vault_pdf_abc",
          title: "Source document — Delta_Park_Fact_Sheet.pdf",
          type: "uploaded_pdf",
          filename: "Delta_Park_Fact_Sheet.pdf",
        },
        {
          vaultItemId: "vault_pdf_xyz",
          title: "Source document — Lokalplan_79.pdf",
          type: "uploaded_pdf",
          filename: "Lokalplan_79.pdf",
        },
      ],
    },
  );
  assert.match(prompt, /Uploaded documents already in the Vault for this assignment:/);
  assert.match(prompt, /vault:vault_pdf_abc — Source document — Delta_Park_Fact_Sheet\.pdf/);
  assert.match(prompt, /vault:vault_pdf_xyz — Source document — Lokalplan_79\.pdf/);
  assert.match(prompt, /sourceDocuments\[\]\.id = `vault:<id>`/);
});

function candidate(
  overrides: Pick<AddressCandidate, "coordinateSource"> & Partial<AddressCandidate>,
): AddressCandidate {
  return {
    id: "frederiksdalsvej-80a",
    label: "Frederiksdalsvej 80A, 2830 Virum",
    coordinates: { x: 724000, y: 6182000, srid: "EPSG:25832" },
    ...overrides,
    source: { provider: "Dataforsyningen", serviceId: "gsearch" },
  };
}
