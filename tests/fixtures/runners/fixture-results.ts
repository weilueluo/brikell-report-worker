import type { AddressCandidate } from "@brikell/shared";
import { notReviewed, sectionNotReviewed } from "@brikell/shared";
import type { ReportV1 } from "@brikell/shared";
import type { SourceDocument } from "@brikell/shared";
import type { UploadedVaultDoc } from "../../../src/vault/uploaded-docs";
import type { ManagedRunnerResult } from "../../../src/agent/runner-client";

const MOCK_REASON = "Test fixture did not collect live data.";

/**
 * Hand-rolled canonical V1 report used by tests as a `staticReportRunner`
 * payload. Mirrors the shape the real runner would produce when no real
 * datasource calls are made: every fact is `not_reviewed` with a fixed reason.
 */
export function buildFixtureCanonicalReport(
  jobId: string,
  address: AddressCandidate,
  generatedAt: string,
  options: { uploadedDocuments?: ReadonlyArray<UploadedVaultDoc> } = {},
): ReportV1 {
  const sourceDocuments: SourceDocument[] = (options.uploadedDocuments ?? []).map((doc) => ({
    id: `vault:${doc.vaultItemId}`,
    type: "other" as const,
    title: doc.title,
  }));
  return {
    schemaVersion: "v1",
    reportId: jobId,
    generatedAt,
    subject: { inputAddress: address.label },
    scopeNote: MOCK_REASON,
    sections: {
      propertyIdentification: {
        bfeNumber: notReviewed(MOCK_REASON),
        bbrAddress: notReviewed(MOCK_REASON),
        numberOfGrunde: notReviewed(MOCK_REASON),
        formerMunicipalPropertyNumber: notReviewed(MOCK_REASON),
        parcel: notReviewed(MOCK_REASON),
        parcelArea: notReviewed(MOCK_REASON),
        waterSupply: notReviewed(MOCK_REASON),
        drainage: notReviewed(MOCK_REASON),
        additionalFacts: [],
      },
      buildings: sectionNotReviewed(MOCK_REASON),
      technicalInstallations: sectionNotReviewed(MOCK_REASON),
      residentialUnitGroups: sectionNotReviewed(MOCK_REASON),
      kommuneplan: { availability: "not_reviewed", reason: MOCK_REASON },
      lokalplaner: sectionNotReviewed(MOCK_REASON),
    },
    sourceDocuments,
  };
}

/**
 * Hand-rolled markdown payload matching the legacy mock runner output. Tests
 * rely on `^# Brikell Property Intelligence Report` to assert which path the
 * report-service picked.
 */
export function buildFixtureReportMarkdown(_jobId: string, address: AddressCandidate): string {
  return `# Brikell Property Intelligence Report

## Address overview

The confirmed address is ${address.label}. Dataforsyningen is the source for the selected address candidate.

## Public-data snapshot

Live public property, building, unit, and planning facts would be summarized here when the report is generated with live data access.

## Planning and document context

Planning context and reviewed document contents would be included when relevant public records or document links are available.

## Limitations

This preview report is for local UI testing. It does not contain live public registry facts and should not be used for decisions.

## Suggested follow-up

Generate a live public-data-backed report before making property, planning, or diligence decisions.
`;
}

/**
 * Convenience helper that builds the legacy mock-runner payload (markdown +
 * empty mcpCollectionEvidence) used as the default `staticReportRunner` result.
 */
export function buildFixtureMarkdownRunnerResult(
  jobId: string,
  address: AddressCandidate,
): ManagedRunnerResult {
  return {
    markdown: buildFixtureReportMarkdown(jobId, address),
    mcpCollectionEvidence: [],
  };
}

/**
 * Convenience helper that builds the legacy mock-runner payload with a
 * canonical V1 report embedded.
 */
export function buildFixtureCanonicalRunnerResult(
  jobId: string,
  address: AddressCandidate,
  options: { uploadedDocuments?: ReadonlyArray<UploadedVaultDoc>; generatedAt?: string } = {},
): ManagedRunnerResult {
  return {
    markdown: buildFixtureReportMarkdown(jobId, address),
    canonicalReport: buildFixtureCanonicalReport(
      jobId,
      address,
      options.generatedAt ?? new Date().toISOString(),
      { uploadedDocuments: options.uploadedDocuments },
    ),
    canonicalSource: "mock",
    mcpCollectionEvidence: [],
  };
}

/**
 * Empty-runner result simulating an agent that finished without writing
 * final output files.
 */
export function buildFixtureEmptyRunnerResult(
  reason = "Test fixture finished without writing final output files.",
): ManagedRunnerResult {
  return {
    canonicalAbsentReason: reason,
    mcpCollectionEvidence: [],
  };
}

/**
 * Markdown-only result with an explicit `canonicalAbsentReason`. Used for
 * "fall back to runner Markdown" tests where canonical output is not
 * produced.
 */
export function buildFixtureMarkdownOnlyResult(
  jobId: string,
  address: AddressCandidate,
  reason = "Test fixture did not emit canonical V1 output.",
): ManagedRunnerResult {
  return {
    markdown: buildFixtureReportMarkdown(jobId, address),
    canonicalAbsentReason: reason,
    mcpCollectionEvidence: [],
  };
}
