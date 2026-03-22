"""
Persistent Chroma vector store for chat RAG: semantic search across past conversations.

Uses cosine distance with OpenAI text-embedding-3-small vectors (same as embeddings.py).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, List, Optional

import chromadb
from chromadb.config import Settings

from config import chroma_dir

from .schemas import Chunk, SearchResult


def _build_where(
    source_types: Optional[List[str]],
    exclude_source_id: Optional[str],
) -> Optional[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    if source_types:
        parts.append({"source_type": {"$in": list(source_types)}})
    if exclude_source_id:
        parts.append({"source_id": {"$ne": str(exclude_source_id)}})
    if not parts:
        return None
    if len(parts) == 1:
        return parts[0]
    return {"$and": parts}


class ChromaChatMemory:
    """Chroma PersistentClient: one collection of chat chunks + embeddings."""

    COLLECTION = "jarvis_chat_chunks"

    def __init__(self, persist_path: Optional[Path] = None) -> None:
        path = persist_path or chroma_dir()
        path.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._client = chromadb.PersistentClient(
            path=str(path),
            settings=Settings(anonymized_telemetry=False),
        )
        self._col = self._client.get_or_create_collection(
            name=self.COLLECTION,
            metadata={"hnsw:space": "cosine"},
        )

    @property
    def persist_path(self) -> Path:
        return self._path

    def delete_by_source_id(self, source_id: str) -> None:
        """Remove all chunks belonging to one chat (before re-ingest or on chat delete)."""
        if not source_id:
            return
        try:
            self._col.delete(where={"source_id": str(source_id)})
        except Exception:
            pass

    def upsert_chat_chunks(self, chunks: List[Chunk], embeddings: List[List[float]]) -> None:
        """Add chunks for one chat; caller must delete_by_source_id first for a clean replace."""
        if not chunks or len(chunks) != len(embeddings):
            return
        ids = [c.chunk_id for c in chunks]
        # Chroma document length limits — keep generous headroom
        documents = [(c.content or "")[:16_000] for c in chunks]
        metadatas: list[dict[str, Any]] = []
        for c in chunks:
            metadatas.append(
                {
                    "source_id": str(c.source_id),
                    "source_type": str(c.source_type),
                    "summary": ((c.summary or "")[:450]),
                }
            )
        self._col.add(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)

    def search(
        self,
        query_embedding: List[float],
        top_k: int = 10,
        min_score: Optional[float] = None,
        source_types: Optional[List[str]] = None,
        exclude_source_id: Optional[str] = None,
    ) -> List[SearchResult]:
        if not query_embedding:
            return []
        where = _build_where(source_types, exclude_source_id)
        n_fetch = min(max(top_k * 3, top_k + 5), 80)
        kw: dict[str, Any] = {
            "query_embeddings": [query_embedding],
            "n_results": n_fetch,
            "include": ["documents", "metadatas", "distances"],
        }
        if where is not None:
            kw["where"] = where
        try:
            res = self._col.query(**kw)
        except Exception:
            return []
        ids_list = res.get("ids") or []
        if not ids_list or not ids_list[0]:
            return []
        ids = ids_list[0]
        docs = (res.get("documents") or [[]])[0]
        metas = (res.get("metadatas") or [[]])[0]
        dists = (res.get("distances") or [[]])[0]

        out: list[SearchResult] = []
        for i, dist in enumerate(dists):
            # cosine space: distance = 1 - cosine_similarity for normalized vectors
            sim = max(0.0, min(1.0, 1.0 - float(dist)))
            if min_score is not None and sim < min_score:
                continue
            meta = dict(metas[i]) if i < len(metas) and metas[i] else {}
            doc = docs[i] if i < len(docs) else ""
            cid = ids[i] if i < len(ids) else f"unknown_{i}"
            summ = meta.get("summary") or None
            out.append(
                SearchResult(
                    chunk_id=cid,
                    score=round(sim, 4),
                    summary=summ,
                    metadata=meta,
                    raw_content=doc,
                )
            )
            if len(out) >= top_k:
                break
        return out

    def count(self) -> int:
        try:
            return int(self._col.count())
        except Exception:
            return 0

    def __len__(self) -> int:
        return self.count()

    def get_by_chunk_ids(self, chunk_ids: List[str]) -> list[dict[str, Any]]:
        """Resolve chunk_id → full document + metadata stored in Chroma."""
        if not chunk_ids:
            return []
        unique = list(dict.fromkeys(chunk_ids))
        try:
            res = self._col.get(ids=unique, include=["documents", "metadatas"])
        except Exception:
            return []
        ids = res.get("ids") or []
        docs = res.get("documents") or []
        metas = res.get("metadatas") or []
        out: list[dict[str, Any]] = []
        for i, cid in enumerate(ids):
            meta = dict(metas[i]) if i < len(metas) and metas[i] else {}
            content = docs[i] if i < len(docs) else ""
            out.append({"chunk_id": cid, "content": content, "metadata": meta})
        return out
