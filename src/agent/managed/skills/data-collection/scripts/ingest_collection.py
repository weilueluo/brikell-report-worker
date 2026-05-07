from __future__ import annotations

import copy
import hashlib
import json
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

from _shared import (
    RAW_DIR,
    ProvenanceError,
    assert_ref,
    compact_json,
    emit_status,
    open_store,
    request_key,
    response_payload,
    strip_doc_text,
)


class IngestError(Exception):
    def __init__(self, code: str, safe_message: str, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.safe_message = safe_message
        self.retryable = retryable


def main(argv: list[str]) -> int:
    if len(argv) != 2 or not argv[1].strip():
        emit_status(_failure("property.collect", "invalid_args", "Usage: python ingest_collection.py <collection_id>", False, None))
        return 2

    collection_id = argv[1].strip()
    intent = "property.collect"
    conn: sqlite3.Connection | None = None
    try:
        conn = open_store()
        raw_dir = Path(RAW_DIR) / collection_id
        envelope_path = raw_dir / "envelope.json"
        if not envelope_path.exists():
            existing = _existing_status(conn, collection_id)
            if existing:
                emit_status(existing)
                return 0
            raise IngestError("raw_envelope_missing", "Mounted collection envelope is missing.", True)

        raw_bytes = envelope_path.read_bytes()
        raw_text = raw_bytes.decode("utf-8")
        mounted_envelope = json.loads(raw_text)
        if not isinstance(mounted_envelope, dict):
            raise IngestError("invalid_envelope", "Mounted collection envelope is not a JSON object.")

        payload = response_payload(mounted_envelope)
        ref = assert_ref(payload)
        intent = _detect_intent(mounted_envelope, payload, ref)
        args = _extract_args(mounted_envelope, payload, ref)
        args_canonical = compact_json(args)
        req_key = request_key(intent, args)

        existing = _existing_status(conn, collection_id)
        if existing:
            _cleanup_raw(raw_dir)
            emit_status(existing)
            return 0

        if intent == "planning.collect":
            stripped_payload, documents = strip_doc_text(payload, raw_dir)
        else:
            stripped_payload, documents = payload, []

        expected_sha, expected_bytes = _expected_integrity(mounted_envelope)
        response_text, response_sha256, response_bytes = _choose_response_integrity(
            payload=payload,
            raw_text=raw_text,
            intent=intent,
            documents=documents,
            expected_sha=expected_sha,
            expected_bytes=expected_bytes,
        )
        status = _collection_status(intent, payload, documents)
        records_count = _count_records(stripped_payload)
        key_rows = _collection_keys(intent, stripped_payload, documents, ref)

        with conn:
            attempt_number = _next_attempt_number(conn, req_key)
            conn.execute(
                """
                INSERT INTO collections (
                  collection_id, intent, args_canonical, request_key, attempt_number, status,
                  fetched_at, source, upstream_id, response_sha256, response_bytes, response_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    collection_id,
                    intent,
                    args_canonical,
                    req_key,
                    attempt_number,
                    status,
                    ref["fetchedAt"],
                    ref["source"],
                    ref.get("upstreamId"),
                    response_sha256,
                    response_bytes,
                    compact_json(stripped_payload),
                ),
            )
            for key_kind, key_value in sorted(key_rows):
                conn.execute(
                    "INSERT OR IGNORE INTO collection_keys (collection_id, key_kind, key_value) VALUES (?, ?, ?)",
                    (collection_id, key_kind, key_value),
                )
            for document in documents:
                conn.execute(
                    """
                    INSERT OR REPLACE INTO documents (
                      document_id, collection_id, source, upstream_id, plan_id, fetched_at, url,
                      content_type, byte_size, sha256, page_count, ocr_used, extraction_status,
                      text, pages_offsets
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        document["documentId"],
                        collection_id,
                        document["source"],
                        document["upstreamId"],
                        document.get("planId"),
                        document.get("fetchedAt") or ref["fetchedAt"],
                        document.get("url") or "",
                        document.get("contentType"),
                        document.get("byteSize"),
                        document["sha256"],
                        document.get("pageCount"),
                        1 if document.get("ocrUsed") else 0,
                        document["extractionStatus"],
                        document.get("text") or "",
                        compact_json(_pages_offsets(document.get("text") or "", document.get("pages") or [])),
                    ),
                )

        _cleanup_raw(raw_dir)
        emit_status({
            "ok": True,
            "intent": intent,
            "collection_id": collection_id,
            "request_key": req_key,
            "status": status,
            "ref": ref,
            "counts": {"records": records_count, "documents": len(documents)},
            "response_sha256": response_sha256,
            "response_bytes": response_bytes,
        })
        return 0
    except ProvenanceError as error:
        emit_status(_failure(intent, error.code, "Datasource response did not include valid provenance.", False, collection_id))
        return 1
    except IngestError as error:
        emit_status(_failure(intent, error.code, error.safe_message, error.retryable, collection_id))
        return 1
    except (json.JSONDecodeError, UnicodeDecodeError):
        emit_status(_failure(intent, "invalid_envelope", "Mounted collection envelope could not be parsed as UTF-8 JSON.", False, collection_id))
        return 1
    except sqlite3.IntegrityError:
        emit_status(_failure(intent, "sqlite_integrity_error", "Collection could not be stored because a SQLite constraint failed.", False, collection_id))
        return 1
    except Exception:
        emit_status(_failure(intent, "internal_ingest_error", "Collection ingestion failed before completion.", False, collection_id))
        return 1
    finally:
        if conn is not None:
            conn.close()


def _failure(intent: str, code: str, safe_message: str, retryable: bool, partial_collection_id: str | None) -> dict[str, Any]:
    if intent not in {"address.resolve", "property.collect", "planning.collect"}:
        intent = "property.collect"
    return {
        "ok": False,
        "intent": intent,
        "code": code,
        "retryable": retryable,
        "safe_message": safe_message,
        "partial_collection_id": partial_collection_id,
    }


def _detect_intent(envelope: dict[str, Any], payload: dict[str, Any], ref: dict[str, str]) -> str:
    explicit = _first_string(envelope.get("intent"), payload.get("intent"))
    if explicit in {"address.resolve", "property.collect", "planning.collect"}:
        return explicit
    handle = envelope.get("handle")
    if isinstance(handle, dict):
        explicit = _first_string(handle.get("intent"))
        if explicit in {"address.resolve", "property.collect", "planning.collect"}:
            return explicit
    source = ref.get("source", "").lower()
    if "forsyn" in source or "dar" in source:
        return "address.resolve"
    if "fordeler" in source or "bbr" in source or "mat" in source:
        return "property.collect"
    if "plan" in source:
        return "planning.collect"
    if any(key in payload for key in ("plans", "geometryRecords", "documents", "documentsCompleted")):
        return "planning.collect"
    if any(key in payload for key in ("address", "addresses", "candidates", "darId")):
        return "address.resolve"
    return "property.collect"


def _extract_args(envelope: dict[str, Any], payload: dict[str, Any], ref: dict[str, str]) -> dict[str, Any]:
    for key in ("args", "arguments", "toolInput", "tool_input"):
        value = envelope.get(key)
        if isinstance(value, dict):
            return value
    handle = envelope.get("handle")
    if isinstance(handle, dict):
        for key in ("args", "arguments", "toolInput", "tool_input"):
            value = handle.get(key)
            if isinstance(value, dict):
                return value
    if ref.get("upstreamId"):
        return {"upstreamId": ref["upstreamId"]}
    fallback_id = _first_string(payload.get("planId"), payload.get("propertyId"), payload.get("addressId"), payload.get("darId"))
    return {"upstreamId": fallback_id} if fallback_id else {}


def _expected_integrity(envelope: dict[str, Any]) -> tuple[str | None, int | None]:
    candidates = [envelope]
    handle = envelope.get("handle")
    if isinstance(handle, dict):
        candidates.append(handle)
    for candidate in candidates:
        sha = candidate.get("response_sha256")
        byte_count = candidate.get("response_bytes")
        if isinstance(sha, str) or isinstance(byte_count, int):
            return sha if isinstance(sha, str) else None, byte_count if isinstance(byte_count, int) else None
    return None, None


def _choose_response_integrity(
    *,
    payload: dict[str, Any],
    raw_text: str,
    intent: str,
    documents: list[dict[str, Any]],
    expected_sha: str | None,
    expected_bytes: int | None,
) -> tuple[str, str, int]:
    candidates: list[str] = [raw_text, compact_json(payload)]
    if intent == "planning.collect" and documents:
        restored = _restore_doc_text_for_hash(copy.deepcopy(payload), documents)
        candidates.insert(0, compact_json(restored))
    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate not in seen:
            deduped.append(candidate)
            seen.add(candidate)

    if expected_sha or expected_bytes is not None:
        for candidate in deduped:
            sha = hashlib.sha256(candidate.encode("utf-8")).hexdigest()
            byte_count = len(candidate.encode("utf-8"))
            if (expected_sha is None or sha == expected_sha) and (expected_bytes is None or byte_count == expected_bytes):
                return candidate, sha, byte_count
        raise IngestError("response_integrity_mismatch", "Mounted collection envelope failed response integrity verification.")

    chosen = deduped[0]
    sha = hashlib.sha256(chosen.encode("utf-8")).hexdigest()
    return chosen, sha, len(chosen.encode("utf-8"))


def _restore_doc_text_for_hash(node: Any, documents: list[dict[str, Any]]) -> Any:
    by_id = {document["documentId"]: document for document in documents}

    def visit(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        document_id = _document_ref_id(value)
        if document_id and document_id in by_id:
            document = by_id[document_id]
            if "text" in value:
                value["text"] = document.get("text") or ""
            if "pages" in value:
                value["pages"] = document.get("pages") or []
            if value.get("documentRefId") == document_id:
                value.pop("documentRefId", None)
        for child in list(value.values()):
            visit(child)

    visit(node)
    return node


def _document_ref_id(node: dict[str, Any]) -> str | None:
    direct = node.get("documentRefId")
    if isinstance(direct, str) and direct:
        return direct
    for key in ("text", "pages"):
        value = node.get(key)
        if isinstance(value, dict) and isinstance(value.get("documentRefId"), str) and value["documentRefId"]:
            return value["documentRefId"]
    return None


def _next_attempt_number(conn: sqlite3.Connection, req_key: str) -> int:
    row = conn.execute("SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt FROM collections WHERE request_key = ?", (req_key,)).fetchone()
    return int(row["next_attempt"] if row else 1)


def _existing_status(conn: sqlite3.Connection, collection_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM collections WHERE collection_id = ?", (collection_id,)).fetchone()
    if row is None:
        return None
    documents = conn.execute("SELECT COUNT(*) AS count FROM documents WHERE collection_id = ?", (collection_id,)).fetchone()
    response_json = json.loads(row["response_json"])
    ref = {"source": row["source"], "fetchedAt": row["fetched_at"]}
    if row["upstream_id"]:
        ref["upstreamId"] = row["upstream_id"]
    return {
        "ok": True,
        "intent": row["intent"],
        "collection_id": collection_id,
        "request_key": row["request_key"],
        "status": row["status"],
        "ref": ref,
        "counts": {"records": _count_records(response_json), "documents": int(documents["count"] if documents else 0)},
        "response_sha256": row["response_sha256"],
        "response_bytes": int(row["response_bytes"]),
    }


def _collection_status(intent: str, payload: dict[str, Any], documents: list[dict[str, Any]]) -> str:
    explicit = _first_string(payload.get("status"))
    if explicit == "error":
        return "error"
    if intent == "planning.collect" and any(document.get("extractionStatus") != "ok" for document in documents):
        return "partial"
    if explicit == "partial":
        return "partial"
    return "success"


def _collection_keys(intent: str, payload: dict[str, Any], documents: list[dict[str, Any]], ref: dict[str, str]) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    if intent == "address.resolve" and ref.get("upstreamId"):
        keys.add(("address_id", ref["upstreamId"]))
    if intent == "planning.collect":
        _collect_named_keys(payload, keys, {
            "plan_id": {"planId", "planid", "plan_id", "plannr", "planNr"},
        })
        for document in documents:
            keys.add(("document_id", document["upstreamId"]))
            if document.get("planId"):
                keys.add(("plan_id", document["planId"]))
        return keys
    field_map = {
        "address_id": {"addressId", "address_id", "darId", "dar_id", "darAddressId", "adresseId", "adresse_id", "adgangsadresseId", "enhedsadresseId"},
        "building_id": {"buildingId", "building_id", "bbrBuildingId", "bbr_bygning_id", "bbrBygningId", "bygningId", "bygning_id"},
        "parcel_id": {"parcelId", "parcel_id", "jordstykkeId", "jordstykke_id", "matrikelId", "matrikel_id", "matParcelId"},
        "unit_id": {"unitId", "unit_id", "ebrUnitId", "enhedId", "enhed_id", "bbrUnitId"},
    }
    _collect_named_keys(payload, keys, field_map)
    _collect_parcel_composites(payload, keys)
    return keys


def _collect_named_keys(node: Any, keys: set[tuple[str, str]], field_map: dict[str, set[str]]) -> None:
    if isinstance(node, list):
        for item in node:
            _collect_named_keys(item, keys, field_map)
        return
    if not isinstance(node, dict):
        return
    for key, value in node.items():
        for kind, names in field_map.items():
            if key in names:
                for text in _scalar_values(value):
                    keys.add((kind, text))
        if isinstance(value, (dict, list)):
            _collect_named_keys(value, keys, field_map)


def _collect_parcel_composites(node: Any, keys: set[tuple[str, str]]) -> None:
    if isinstance(node, list):
        for item in node:
            _collect_parcel_composites(item, keys)
        return
    if not isinstance(node, dict):
        return
    ejerlav = _first_string(node.get("ejerlavKode"), node.get("ejerlav_code"))
    matrikel = _first_string(node.get("matrikelnummer"), node.get("matrikelNr"), node.get("matrikel_nr"))
    if ejerlav and matrikel:
        keys.add(("parcel_id", f"{ejerlav}:{matrikel}"))
    for value in node.values():
        if isinstance(value, (dict, list)):
            _collect_parcel_composites(value, keys)


def _scalar_values(value: Any) -> list[str]:
    if isinstance(value, list):
        return [item for nested in value for item in _scalar_values(nested)]
    if isinstance(value, str) and value:
        return [value]
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return [str(value)]
    return []


def _count_records(value: Any) -> int:
    total = 0
    saw_record_array = False

    def visit(node: Any, key: str | None = None) -> None:
        nonlocal total, saw_record_array
        if isinstance(node, list):
            if key in {"records", "geometryRecords", "features"}:
                total += len(node)
                saw_record_array = True
            for item in node:
                visit(item)
            return
        if isinstance(node, dict):
            for child_key, child in node.items():
                visit(child, child_key)

    visit(value)
    return total if saw_record_array else 1


def _pages_offsets(text: str, pages: list[Any]) -> list[dict[str, int]]:
    offsets: list[dict[str, int]] = []
    cursor = 0
    for index, page in enumerate(pages):
        page_number = index + 1
        page_text = ""
        if isinstance(page, dict):
            raw_page_number = page.get("page") or page.get("pageNumber") or page.get("number")
            if isinstance(raw_page_number, int):
                page_number = raw_page_number
            page_text = page.get("text") if isinstance(page.get("text"), str) else ""
        if page_text:
            start = text.find(page_text, cursor)
            if start < 0:
                start = text.find(page_text)
            if start < 0:
                start = cursor
            end = min(len(text), start + len(page_text))
            cursor = end
        else:
            start = cursor
            end = cursor
        offsets.append({"page": page_number, "start": start, "end": end})
    if not offsets and text:
        offsets.append({"page": 1, "start": 0, "end": len(text)})
    return offsets


def _cleanup_raw(raw_dir: Path) -> None:
    shutil.rmtree(raw_dir, ignore_errors=True)


def _first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value:
            return value
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return str(value)
    return None


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
