# Document review

Document links and attachments from datasource responses or user input are metadata until the managed session fetches and processes the content.

## Workflow

1. Review available document metadata first: URL, title, source field, content status, source record, and provenance.
2. Fetch content when the task needs document text or when an explicit datasource/user link is likely to contain requested report facts, such as planning restrictions, capacity limits, environmental conditions, or due-diligence context.
3. Use the managed-session document tools, not provider MCP tools or global plugins, to download or read the file.
4. Download explicit links into a session-only document workspace. Do not inspect or write host-side artifact directories.
5. Record provenance before extracting text: source label, input URL, final URL, HTTP status, content type, content length, byte length, SHA-256, and created timestamp.
6. Extract native PDF text first with the configured PDF text tooling. OCR is a fallback for scanned or image-only documents.
7. Treat download metadata, native text, OCR text, and page references as separate evidence. Cite page numbers from the extracted text artifacts.
8. If a report includes document links without fetching them, say that the links are metadata only and do not make document-content claims.

## Managed-session tools

The managed session environment should already provide:

- `curl` for fetching explicit HTTPS document links.
- `pdfinfo` and `pdftotext` from Poppler for PDF inspection and native text extraction.
- `pdftoppm` and `tesseract` for local OCR fallback when native text is insufficient.

## Artifacts

The managed-session workflow writes evidence artifacts in the session workspace:

- `document.json` - metadata, provenance, PDF inspection, extraction/OCR status, page inventory, warnings, and artifact paths.
- `document.md` - page-separated text for citation.
- `document.txt` - plain text with page markers.
- `source.pdf` or `source.txt` when source-file storage is enabled.

SQLite facts and text indexes are navigation aids only. The artifact manifest and source hash are the document evidence source.
