import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mcpEvidenceSourceLink,
  sanitizeUrl,
  supportedMcpEvidenceLinkKeys,
} from "../src/vault/source-links";

test("supportedMcpEvidenceLinkKeys returns the locked-down (provider, tool) surface", () => {
  assert.deepEqual(supportedMcpEvidenceLinkKeys(), [
    "datafordeler.property.resolve_property",
    "dataforsyningen.search_address_or_place",
    "plandata.get_plan",
  ]);
});

test("datafordeler property resolver maps a BFE number to the public datafordeler page", () => {
  const url = mcpEvidenceSourceLink({
    provider: "datafordeler",
    toolName: "property.resolve_property",
    args: { bfeNumber: "12345" },
  });
  assert.equal(url, "https://datafordeler.dk/dataoversigt/ejendomsbeliggenhed/?bfeNumber=12345");
});

test("datafordeler property resolver accepts the {input:{type,value}} shape", () => {
  const url = mcpEvidenceSourceLink({
    provider: "datafordeler",
    toolName: "property.resolve_property",
    args: { input: { type: "bfe", value: "987654" } },
  });
  assert.equal(url, "https://datafordeler.dk/dataoversigt/ejendomsbeliggenhed/?bfeNumber=987654");
});

test("datafordeler property resolver falls back to result.propertyId when args lack the BFE", () => {
  const url = mcpEvidenceSourceLink({
    provider: "datafordeler",
    toolName: "property.resolve_property",
    args: {},
    result: { propertyId: "555" },
  });
  assert.equal(url, "https://datafordeler.dk/dataoversigt/ejendomsbeliggenhed/?bfeNumber=555");
});

test("datafordeler property resolver returns null for non-numeric BFEs", () => {
  const url = mcpEvidenceSourceLink({
    provider: "datafordeler",
    toolName: "property.resolve_property",
    args: { bfeNumber: "abc" },
  });
  assert.equal(url, null);
});

test("dataforsyningen search resolves an explicit DAR address id to the public detail page", () => {
  const url = mcpEvidenceSourceLink({
    provider: "dataforsyningen",
    toolName: "search_address_or_place",
    args: { addressId: "0a3f50a3-823a-32b8-e044-0003ba298018" },
  });
  assert.equal(url, "https://dataforsyningen.dk/data/dar?id=0a3f50a3-823a-32b8-e044-0003ba298018");
});

test("dataforsyningen search falls back to the first candidate id from the result", () => {
  const url = mcpEvidenceSourceLink({
    provider: "dataforsyningen",
    toolName: "search_address_or_place",
    args: { q: "Frederiksdalsvej" },
    result: {
      candidates: [{ id: "0a3f50a3-823a-32b8-e044-0003ba298018", label: "Some address" }],
    },
  });
  assert.equal(url, "https://dataforsyningen.dk/data/dar?id=0a3f50a3-823a-32b8-e044-0003ba298018");
});

test("dataforsyningen search returns null when no candidate id matches the address-id format", () => {
  assert.equal(
    mcpEvidenceSourceLink({
      provider: "dataforsyningen",
      toolName: "search_address_or_place",
      args: { addressId: "not-a-uuid" },
    }),
    null,
  );
  assert.equal(
    mcpEvidenceSourceLink({
      provider: "dataforsyningen",
      toolName: "search_address_or_place",
      args: {},
      result: { candidates: [] },
    }),
    null,
  );
});

test("plandata.get_plan resolves a plan id to plansystem.dk", () => {
  const url = mcpEvidenceSourceLink({
    provider: "plandata",
    toolName: "get_plan",
    args: { planId: "11257054" },
  });
  assert.equal(url, "https://plansystem.dk/plansoeg/?planID=11257054");
});

test("plandata.get_plan rejects ids that do not match the safe character class", () => {
  assert.equal(
    mcpEvidenceSourceLink({
      provider: "plandata",
      toolName: "get_plan",
      args: { planId: "../../../etc/passwd" },
    }),
    null,
  );
});

test("mapper accepts provider-prefixed tool names emitted by the bridge", () => {
  const dotted = mcpEvidenceSourceLink({
    provider: "datafordeler",
    toolName: "datafordeler.property.resolve_property",
    args: { bfeNumber: "1" },
  });
  assert.equal(dotted, "https://datafordeler.dk/dataoversigt/ejendomsbeliggenhed/?bfeNumber=1");

  const underscored = mcpEvidenceSourceLink({
    provider: "datafordeler",
    toolName: "datafordeler_property.resolve_property",
    args: { bfeNumber: "2" },
  });
  assert.equal(underscored, "https://datafordeler.dk/dataoversigt/ejendomsbeliggenhed/?bfeNumber=2");
});

test("returns null for unknown providers, unknown tools, or empty inputs", () => {
  assert.equal(mcpEvidenceSourceLink({ provider: "", toolName: "x" }), null);
  assert.equal(mcpEvidenceSourceLink({ provider: "datafordeler", toolName: "" }), null);
  assert.equal(mcpEvidenceSourceLink({ provider: "datafordeler", toolName: "unknown.tool" }), null);
  assert.equal(mcpEvidenceSourceLink({ provider: "unknown", toolName: "tool" }), null);
});

test("returns null when args is non-record (e.g. null) — mapper sees an empty record", () => {
  const out = mcpEvidenceSourceLink({
    provider: "datafordeler",
    toolName: "property.resolve_property",
    args: null,
    result: "not a record",
  });
  assert.equal(out, null);
});

test("sanitizeUrl strips known auth/credential query parameters", () => {
  const url = sanitizeUrl("https://datafordeler.dk/page?token=abc123&keep=ok&api_key=xx&session=zz");
  assert.equal(url, "https://datafordeler.dk/page?keep=ok");
});

test("sanitizeUrl strips username, password and hash", () => {
  const url = sanitizeUrl("https://user:pw@datafordeler.dk/path?keep=1#frag");
  assert.equal(url, "https://datafordeler.dk/path?keep=1");
});

test("sanitizeUrl rejects non-HTTPS, non-allowlisted hosts and unparseable URLs", () => {
  assert.equal(sanitizeUrl("http://datafordeler.dk/x"), null);
  assert.equal(sanitizeUrl("https://example.com/x"), null);
  assert.equal(sanitizeUrl("not a url"), null);
});
