from __future__ import annotations

import json
import sys
from typing import Any

from _shared import compact_json, open_store

TABLES = ["collections", "documents", "collection_keys", "documents_fts"]

DDL = """
CREATE TABLE IF NOT EXISTS collections (
  collection_id   TEXT PRIMARY KEY,
  intent          TEXT NOT NULL,
  args_canonical  TEXT NOT NULL,
  request_key     TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL CHECK (status IN ('success','partial','error')),
  fetched_at      TEXT NOT NULL,
  source          TEXT NOT NULL,
  upstream_id     TEXT,
  response_sha256 TEXT NOT NULL,
  response_bytes  INTEGER NOT NULL,
  response_json   TEXT NOT NULL,
  property_id     TEXT GENERATED ALWAYS AS (json_extract(response_json, '$.data.property.id')) VIRTUAL,
  bfe_number      TEXT GENERATED ALWAYS AS (json_extract(response_json, '$.data.property.bfeNumber')) VIRTUAL,
  primary_plan_id TEXT GENERATED ALWAYS AS (json_extract(response_json, '$.data.planId')) VIRTUAL
);

CREATE INDEX IF NOT EXISTS idx_collections_intent_fetched ON collections(intent, fetched_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_collections_request_attempt ON collections(request_key, attempt_number);
CREATE INDEX IF NOT EXISTS idx_collections_property_id ON collections(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collections_bfe_number ON collections(bfe_number) WHERE bfe_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collections_primary_plan ON collections(primary_plan_id) WHERE primary_plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collections_request_key ON collections(request_key);

CREATE TABLE IF NOT EXISTS collection_keys (
  collection_id   TEXT NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
  key_kind        TEXT NOT NULL,
  key_value       TEXT NOT NULL,
  PRIMARY KEY (collection_id, key_kind, key_value)
);
CREATE INDEX IF NOT EXISTS idx_collection_keys_lookup ON collection_keys(key_kind, key_value);

CREATE TABLE IF NOT EXISTS documents (
  document_id     TEXT PRIMARY KEY,
  collection_id   TEXT NOT NULL REFERENCES collections(collection_id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  upstream_id     TEXT NOT NULL,
  plan_id         TEXT,
  fetched_at      TEXT NOT NULL,
  url             TEXT NOT NULL,
  content_type    TEXT,
  byte_size       INTEGER,
  sha256          TEXT NOT NULL,
  page_count      INTEGER,
  ocr_used        INTEGER NOT NULL DEFAULT 0,
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('ok','partial','timeout','error')),
  text            TEXT NOT NULL,
  pages_offsets   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id);
CREATE INDEX IF NOT EXISTS idx_documents_source_upstream ON documents(source, upstream_id);
CREATE INDEX IF NOT EXISTS idx_documents_plan_id ON documents(plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_sha256 ON documents(sha256);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  text,
  content='documents',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO documents_fts(rowid, text) VALUES (new.rowid, new.text);
END;
"""


def ensure_schema(conn: Any) -> None:
    conn.executescript(DDL)
    conn.commit()


def _emit(record: dict[str, Any]) -> None:
    print(compact_json(record))


def main() -> int:
    try:
        conn = open_store()
        try:
            ensure_schema(conn)
        finally:
            conn.close()
        _emit({"ok": True, "intent": "init", "tables": TABLES})
        return 0
    except Exception as error:
        _emit({
            "ok": False,
            "intent": "init",
            "code": getattr(error, "code", "schema_init_failed"),
            "retryable": False,
            "safe_message": "SQLite schema initialization failed.",
            "partial_collection_id": None,
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
