import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressCandidate } from "@brikell/shared";
import {
  isDataforsyningenAutocompleteCandidate,
  normalizeAddressSearchResult,
} from "../src/address/service";

test("normalizeAddressSearchResult parses candidates from structuredContent", () => {
  const out = normalizeAddressSearchResult({
    structuredContent: {
      meta: { serviceId: "adresser", fetchedAt: "2024-01-01T00:00:00Z" },
      candidates: [
        {
          properties: {
            id: "abc-1",
            betegnelse: "Frederiksdalsvej 80A, 2830 Virum",
            vejnavn: "Frederiksdalsvej",
            husnr: "80A",
            postnr: "2830",
            postnrnavn: "Virum",
            kommunekode: "0173",
            geometry: { coordinates: [724000, 6182000] },
          },
        },
      ],
    },
  });

  assert.equal(out.length, 1);
  const [first] = out;
  assert.equal(first.id, "abc-1");
  assert.equal(first.label, "Frederiksdalsvej 80A, 2830 Virum");
  assert.equal(first.street, "Frederiksdalsvej");
  assert.equal(first.houseNumber, "80A");
  assert.equal(first.postalCode, "2830");
  assert.equal(first.city, "Virum");
  assert.equal(first.municipalityCode, "0173");
  assert.deepEqual(first.coordinates, { x: 724000, y: 6182000, srid: "EPSG:25832" });
  assert.equal(first.coordinateSource, "selected-candidate");
  assert.equal(first.source.provider, "Dataforsyningen");
  assert.equal(first.source.serviceId, "adresser");
});

test("normalizeAddressSearchResult parses candidates wrapped in a JSON text content block", () => {
  const out = normalizeAddressSearchResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          candidates: [
            {
              properties: {
                id: "abc-2",
                tekst: "Vesterbrogade 1, 1620 København V",
                x: 720_000,
                y: 6_175_000,
              },
            },
          ],
        }),
      },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, "abc-2");
  assert.equal(out[0]!.label, "Vesterbrogade 1, 1620 København V");
  assert.deepEqual(out[0]!.coordinates, { x: 720_000, y: 6_175_000, srid: "EPSG:25832" });
});

test("normalizeAddressSearchResult drops records without a usable label", () => {
  const out = normalizeAddressSearchResult({
    structuredContent: {
      candidates: [{ properties: {} }, { properties: { betegnelse: "  " } }, "not-a-record"],
    },
  });
  assert.equal(out.length, 0);
});

test("normalizeAddressSearchResult discards coordinate pairs outside the Danish EPSG:25832 envelope", () => {
  const out = normalizeAddressSearchResult({
    structuredContent: {
      candidates: [
        {
          properties: {
            betegnelse: "Out of bounds",
            geometry: { coordinates: [10, 10] },
          },
        },
      ],
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.coordinates, undefined);
});

test("normalizeAddressSearchResult returns an empty list for non-record / unparseable payloads", () => {
  assert.deepEqual(normalizeAddressSearchResult(undefined), []);
  assert.deepEqual(normalizeAddressSearchResult("string"), []);
  assert.deepEqual(normalizeAddressSearchResult({ content: [{ type: "text", text: "not json" }] }), []);
});

test("isDataforsyningenAutocompleteCandidate distinguishes gsearch autocomplete results", () => {
  const autocompleted: AddressCandidate = {
    id: "x",
    label: "x",
    source: { provider: "Dataforsyningen", serviceId: "gsearch" },
  };
  const adresser: AddressCandidate = {
    id: "x",
    label: "x",
    source: { provider: "Dataforsyningen", serviceId: "adresser" },
  };
  assert.equal(isDataforsyningenAutocompleteCandidate(autocompleted), true);
  assert.equal(isDataforsyningenAutocompleteCandidate(adresser), false);
});
