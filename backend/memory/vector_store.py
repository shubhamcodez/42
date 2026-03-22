"""In-memory vector store: add chunks with embeddings, similarity search."""
from __future__ import annotations

import math
from typing import Any, List, Optional

from .schemas import Chunk, SearchResult


def _cosine_sim(a: List[float], b: List[float]) -> float:
    """Cosine similarity between two vectors. Assumes same length."""
    if not a or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class VectorStore:
    """
    Store chunks with embeddings; run similarity search.
    In-memory only; can be extended with persistence.
    """

    def __init__(self) -> None:
        self._chunks: List[Chunk] = []
        self._embeddings: List[List[float]] = []

    def add(self, chunk: Chunk, embedding: List[float]) -> None:
        """Append a chunk and its embedding. chunk_id must be unique for dedup if you implement it."""
        self._chunks.append(chunk)
        self._embeddings.append(embedding)

    def delete_by_source_id(self, source_id: str) -> None:
        """Drop all chunks whose source_id matches (e.g. one chat)."""
        if not source_id:
            return
        keep: List[int] = [i for i, c in enumerate(self._chunks) if c.source_id != source_id]
        self._chunks = [self._chunks[i] for i in keep]
        self._embeddings = [self._embeddings[i] for i in keep]

    def search(
        self,
        query_embedding: List[float],
        top_k: int = 10,
        min_score: Optional[float] = None,
        source_types: Optional[List[str]] = None,
        exclude_source_id: Optional[str] = None,
    ) -> List[SearchResult]:
        """
        Return top_k hits by cosine similarity.
        Optionally filter by min_score and source_types.
        """
        if not self._chunks or not query_embedding:
            return []

        scores = [_cosine_sim(query_embedding, emb) for emb in self._embeddings]
        indexed = list(enumerate(scores))
        if min_score is not None:
            indexed = [(i, s) for i, s in indexed if s >= min_score]
        if source_types is not None:
            st_set = set(source_types)
            indexed = [(i, s) for i, s in indexed if self._chunks[i].source_type in st_set]
        if exclude_source_id:
            indexed = [
                (i, s)
                for i, s in indexed
                if self._chunks[i].source_id != exclude_source_id
            ]
        indexed.sort(key=lambda x: -x[1])
        top = indexed[:top_k]

        out: List[SearchResult] = []
        for idx, score in top:
            c = self._chunks[idx]
            out.append(
                SearchResult(
                    chunk_id=c.chunk_id,
                    score=round(score, 4),
                    summary=c.summary,
                    metadata=c.metadata.copy(),
                    raw_content=c.content,
                )
            )
        return out

    def get_by_chunk_ids(self, chunk_ids: List[str]) -> list[dict[str, Any]]:
        """Resolve chunk_id → full text + metadata (same mapping Chroma uses)."""
        if not chunk_ids:
            return []
        want = set(chunk_ids)
        out: list[dict[str, Any]] = []
        for c in self._chunks:
            if c.chunk_id not in want:
                continue
            out.append(
                {
                    "chunk_id": c.chunk_id,
                    "content": c.content,
                    "metadata": {
                        "source_id": c.source_id,
                        "source_type": c.source_type,
                        "summary": c.summary or "",
                        **(c.metadata or {}),
                    },
                }
            )
        return out

    def __len__(self) -> int:
        return len(self._chunks)
