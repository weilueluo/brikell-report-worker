# Evidence context

The bridge records successful datasource tool calls host-side and returns a bounded `sql_datasource_context` object to the managed runtime. `sql_datasource_context.facts` is a searchable index of selected scalar facts, not the full source of truth. The returned datasource context or a document artifact manifest with a source hash remains the managed runtime's evidence source for fields that were not indexed.

## Evidence rules

- Successful datasource calls can support factual claims after SQL ingestion.
- SQL facts can support navigation and retrieval, but absence from the fact index does not mean the public datasource field is unavailable.
- Do not inspect host-side database files, run logs, or mirrored output directories from inside the managed runtime. Use returned tool context and explicit document workflow outputs instead.
- Do not guess or query SQLite database paths such as `/mnt/session/sql/session.db`. Datasource SQL capture is not exposed as an in-container database file. If returned `sql_datasource_context` is insufficient, call the relevant datasource tool for more detail.
- MCP `isError` results, validation failures, and bridge exceptions are diagnostics, not facts.
- Limitations, omitted sections, and failed diagnostics should be reflected when they materially affect the answer.
- Document links are metadata only. Claims based on document contents require native text or OCR artifacts with page references and provenance.
- Web search results may supplement public context, but should be kept separate from datasource evidence.
- Do not reveal credentials, tokens, raw authorization headers, or restricted owner/person/EJF data.

## Runtime behavior

There is no deterministic report-verification gate wired into the runtime. Datasource evidence capture is surfaced to the managed runtime through the `sql_datasource_context` returned by datasource tool calls.
