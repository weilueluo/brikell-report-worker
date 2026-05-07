from __future__ import annotations

import copy
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

STORE_PATH = os.environ.get("BRIKELL_STORE_PATH") or os.environ.get("STORE_PATH") or "/mnt/session/data/store.db"
RAW_DIR = os.environ.get("BRIKELL_RAW_DIR") or "/mnt/session/data/raw"
STDOUT_BYTE_CAP = 4096
VALID_INTENTS = {"address.resolve", "property.collect", "planning.collect"}
VALID_STATUSES = {"success", "partial", "error"}
VALID_EXTRACTION_STATUSES = {"ok", "partial", "timeout", "error"}


class ProvenanceError(Exception):
    def __init__(self, code: str = "provenance_missing") -> None:
        super().__init__(code)
        self.code = code


class StatusValidationError(Exception):
    pass


def debug(message: str) -> None:
    if os.environ.get("BRIKELL_SKILL_DEBUG") == "1":
        print(message, file=sys.stderr)


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def open_store() -> sqlite3.Connection:
    if STORE_PATH != ":memory:":
        Path(STORE_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(STORE_PATH)
    conn.row_factory = sqlite3.Row
    _apply_pragmas(conn)
    if not _table_exists(conn, "collections"):
        import init_store

        init_store.ensure_schema(conn)
    return conn


def _apply_pragmas(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA synchronous = NORMAL")


def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1",
        (table_name,),
    ).fetchone()
    return row is not None


def mint_collection_id() -> str:
    return str(uuid.uuid4())


def request_key(intent: str, args: dict[str, Any]) -> str:
    canonical = compact_json(args or {})
    return hashlib.sha256(f"{intent}{canonical}".encode("utf-8")).hexdigest()


def assert_ref(envelope: dict[str, Any]) -> dict[str, str]:
    payload = response_payload(envelope)
    ref = _read_ref(payload)
    if not ref:
        raise ProvenanceError("provenance_missing")
    source = ref.get("source")
    fetched_at = ref.get("fetchedAt")
    if not isinstance(source, str) or not source.strip() or not isinstance(fetched_at, str) or not _is_iso8601(fetched_at):
        raise ProvenanceError("provenance_missing")
    clean = {"source": source, "fetchedAt": fetched_at}
    upstream_id = ref.get("upstreamId")
    if isinstance(upstream_id, str) and upstream_id:
        clean["upstreamId"] = upstream_id
    return clean


def response_payload(envelope: Any) -> dict[str, Any]:
    if isinstance(envelope, dict) and _read_ref(envelope):
        return envelope
    if isinstance(envelope, dict):
        for key in ("structuredContent", "response", "payload", "result", "data"):
            nested = envelope.get(key)
            if isinstance(nested, dict) and _read_ref(nested):
                return nested
    if isinstance(envelope, dict):
        return envelope
    raise ProvenanceError("provenance_missing")


def strip_doc_text(envelope: dict[str, Any], raw_collection_dir: str | Path | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    stripped = copy.deepcopy(envelope)
    envelope_ref = assert_ref(envelope)
    doc_files = _load_document_files(raw_collection_dir)
    records: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add_record(document_id: str, node: dict[str, Any], plan_id: str | None) -> None:
        if document_id in seen:
            return
        record = _build_doc_record(document_id, node, doc_files.get(document_id), envelope_ref, plan_id)
        records.append(record)
        seen.add(document_id)

    def visit(node: Any, plan_id: str | None = None) -> None:
        if isinstance(node, list):
            for item in node:
                visit(item, plan_id)
            return
        if not isinstance(node, dict):
            return

        current_plan_id = _first_string(node.get("planId"), node.get("planid"), node.get("plan_id")) or plan_id
        document_id = _document_ref_id(node)
        if document_id:
            add_record(document_id, node, current_plan_id)
            node["documentRefId"] = document_id
            if "text" in node:
                node["text"] = {"documentRefId": document_id}
            if "pages" in node:
                node["pages"] = {"documentRefId": document_id}
        elif isinstance(node.get("text"), str) and _is_document_like(node):
            document_id = str(uuid.uuid4())
            add_record(document_id, node, current_plan_id)
            node["documentRefId"] = document_id
            node["text"] = {"documentRefId": document_id}
            if "pages" in node:
                node["pages"] = {"documentRefId": document_id}

        for child in list(node.values()):
            visit(child, current_plan_id)

    visit(stripped)
    for document_id, document in doc_files.items():
        if document_id not in seen:
            add_record(document_id, {}, None)
    return stripped, records


def emit_status(record: dict[str, Any]) -> None:
    try:
        _validate_status(record)
        line = compact_json(record)
        if len(line.encode("utf-8")) > STDOUT_BYTE_CAP:
            line = compact_json(_oversized_status(record))
    except Exception:
        line = compact_json(_oversized_status(record))
    print(line)


def _oversized_status(record: dict[str, Any]) -> dict[str, Any]:
    intent = record.get("intent") if record.get("intent") in VALID_INTENTS else "property.collect"
    partial = record.get("collection_id") or record.get("partial_collection_id")
    return {
        "ok": False,
        "intent": intent,
        "code": "internal_oversized_status",
        "retryable": False,
        "safe_message": "Skill status line exceeded the safe stdout size cap.",
        "partial_collection_id": partial if isinstance(partial, str) and partial else None,
    }


def _validate_status(record: dict[str, Any]) -> None:
    if not isinstance(record, dict):
        raise StatusValidationError("status_not_object")
    if record.get("ok") is True:
        if record.get("intent") not in VALID_INTENTS:
            raise StatusValidationError("invalid_intent")
        if not isinstance(record.get("collection_id"), str) or not record["collection_id"]:
            raise StatusValidationError("missing_collection_id")
        if not isinstance(record.get("request_key"), str) or not record["request_key"]:
            raise StatusValidationError("missing_request_key")
        if record.get("status") not in VALID_STATUSES:
            raise StatusValidationError("invalid_status")
        if not isinstance(record.get("response_sha256"), str) or not record["response_sha256"]:
            raise StatusValidationError("missing_response_sha256")
        if not isinstance(record.get("response_bytes"), int) or record["response_bytes"] < 0:
            raise StatusValidationError("invalid_response_bytes")
        counts = record.get("counts")
        if not isinstance(counts, dict) or not isinstance(counts.get("records"), int) or not isinstance(counts.get("documents"), int):
            raise StatusValidationError("invalid_counts")
        ref = record.get("ref")
        if not isinstance(ref, dict) or not isinstance(ref.get("source"), str) or not isinstance(ref.get("fetchedAt"), str):
            raise StatusValidationError("invalid_ref")
        if not _is_iso8601(ref["fetchedAt"]):
            raise StatusValidationError("invalid_ref_time")
        return
    if record.get("ok") is False:
        if record.get("intent") not in VALID_INTENTS:
            raise StatusValidationError("invalid_intent")
        if not isinstance(record.get("code"), str) or not record["code"]:
            raise StatusValidationError("missing_code")
        if not isinstance(record.get("retryable"), bool):
            raise StatusValidationError("missing_retryable")
        if not isinstance(record.get("safe_message"), str) or not record["safe_message"]:
            raise StatusValidationError("missing_safe_message")
        partial = record.get("partial_collection_id")
        if partial is not None and not isinstance(partial, str):
            raise StatusValidationError("invalid_partial_collection_id")
        return
    raise StatusValidationError("missing_ok")


def _read_ref(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    ref = value.get("_ref") or value.get("ref")
    return ref if isinstance(ref, dict) else None


def _is_iso8601(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def _load_document_files(raw_collection_dir: str | Path | None) -> dict[str, dict[str, Any]]:
    if raw_collection_dir is None:
        return {}
    doc_dir = Path(raw_collection_dir) / "document"
    if not doc_dir.exists():
        return {}
    documents: dict[str, dict[str, Any]] = {}
    for path in sorted(doc_dir.glob("*.json")):
        with path.open("r", encoding="utf-8") as handle:
            document = json.load(handle)
        if not isinstance(document, dict):
            continue
        keys = {path.stem}
        for value in (document.get("documentId"), document.get("document_id")):
            if isinstance(value, str) and value:
                keys.add(value)
        metadata = document.get("metadata")
        if isinstance(metadata, dict):
            value = metadata.get("documentRefId")
            if isinstance(value, str) and value:
                keys.add(value)
        for key in keys:
            documents[key] = document
    return documents


def _document_ref_id(node: dict[str, Any]) -> str | None:
    direct = node.get("documentRefId")
    if isinstance(direct, str) and direct:
        return direct
    for key in ("text", "pages"):
        value = node.get(key)
        if isinstance(value, dict) and isinstance(value.get("documentRefId"), str) and value["documentRefId"]:
            return value["documentRefId"]
    return None


def _is_document_like(node: dict[str, Any]) -> bool:
    return any(key in node for key in ("pages", "extraction", "contentStatus", "url", "documentId", "id", "upstreamId"))


def _build_doc_record(
    document_id: str,
    node: dict[str, Any],
    document_file: dict[str, Any] | None,
    envelope_ref: dict[str, str],
    plan_id: str | None,
) -> dict[str, Any]:
    document_file = document_file or {}
    metadata = document_file.get("metadata") if isinstance(document_file.get("metadata"), dict) else {}
    extraction = _first_dict(document_file.get("extraction"), metadata.get("extraction"), node.get("extraction")) or {}
    ref = _read_ref(document_file) or _read_ref(metadata) or _read_ref(node) or envelope_ref
    source = _first_string(ref.get("source"), metadata.get("source"), metadata.get("provider"), node.get("source"), node.get("provider"), envelope_ref.get("source")) or "plandata"
    upstream_id = _first_string(
        ref.get("upstreamId"),
        metadata.get("upstreamId"),
        metadata.get("documentId"),
        metadata.get("id"),
        node.get("upstreamId"),
        node.get("documentId"),
        node.get("id"),
        node.get("sourceId"),
        metadata.get("url"),
        node.get("url"),
        document_id,
    ) or document_id
    pages = _first_list(document_file.get("pages"), node.get("pages")) or []
    text = _first_string(document_file.get("text"), node.get("text"))
    if text is None:
        text = _join_page_text(pages)
    byte_size = _read_non_negative_int(extraction.get("byteSize"), document_file.get("byteSize"), metadata.get("byteSize"))
    if byte_size is None:
        byte_size = len(text.encode("utf-8"))
    page_count = _read_non_negative_int(extraction.get("pageCount"), document_file.get("pageCount"), metadata.get("pageCount"))
    if page_count is None and pages:
        page_count = len(pages)
    sha = _first_string(extraction.get("sha256"), document_file.get("sha256"), metadata.get("sha256")) or hashlib.sha256(text.encode("utf-8")).hexdigest()
    status = _normalize_extraction_status(_first_string(extraction.get("status"), extraction.get("extractionStatus"), node.get("extractionStatus"), node.get("contentStatus")), text)
    return {
        "documentId": document_id,
        "source": source,
        "upstreamId": upstream_id,
        "text": text,
        "pages": pages,
        "sha256": sha,
        "byteSize": byte_size,
        "pageCount": page_count,
        "ocrUsed": _read_bool(extraction.get("ocrUsed"), document_file.get("ocrUsed"), metadata.get("ocrUsed")),
        "extractionStatus": status,
        "planId": _first_string(metadata.get("planId"), metadata.get("planid"), node.get("planId"), node.get("planid"), plan_id),
        "url": _first_string(metadata.get("url"), node.get("url"), document_file.get("url")) or "",
        "fetchedAt": _first_string(ref.get("fetchedAt"), envelope_ref.get("fetchedAt")) or envelope_ref["fetchedAt"],
    }


def _first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value:
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return None


def _first_dict(*values: Any) -> dict[str, Any] | None:
    for value in values:
        if isinstance(value, dict):
            return value
    return None


def _first_list(*values: Any) -> list[Any] | None:
    for value in values:
        if isinstance(value, list):
            return value
    return None


def _read_non_negative_int(*values: Any) -> int | None:
    for value in values:
        if isinstance(value, bool):
            continue
        if isinstance(value, int) and value >= 0:
            return value
        if isinstance(value, float) and value.is_integer() and value >= 0:
            return int(value)
    return None


def _read_bool(*values: Any) -> bool:
    for value in values:
        if isinstance(value, bool):
            return value
    return False


def _join_page_text(pages: Iterable[Any]) -> str:
    chunks: list[str] = []
    for page in pages:
        if isinstance(page, dict) and isinstance(page.get("text"), str):
            chunks.append(page["text"])
    return "\n\n".join(chunks)


def _normalize_extraction_status(raw: str | None, text: str) -> str:
    if raw in VALID_EXTRACTION_STATUSES:
        return raw
    if raw == "not_fetched":
        return "error"
    return "ok" if text else "error"
