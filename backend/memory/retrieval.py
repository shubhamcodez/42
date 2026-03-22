"""
Retrieval pipeline: current conversation → build query → vector search → rerank/filter → inject into prompt.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from .embeddings import embed_single
from .query import build_retrieval_query
from .schemas import SearchResult, WorkingState
from .vector_store import VectorStore


def retrieve(
    store: VectorStore,
    openai_api_key: str,
    query_text: str,
    top_k: int = 10,
    min_score: Optional[float] = 0.2,
    source_types: Optional[List[str]] = None,
    exclude_source_id: Optional[str] = None,
) -> List[SearchResult]:
    """
    Embed the query, run vector search, return ranked results.
    Uses OpenAI for embedding (openai_api_key required).
    exclude_source_id: omit chunks from this chat (e.g. current chat — history is already in-window).
    """
    if not query_text.strip():
        return []
    query_embedding = embed_single(openai_api_key, query_text)
    return store.search(
        query_embedding,
        top_k=top_k,
        min_score=min_score,
        source_types=source_types,
        exclude_source_id=exclude_source_id,
    )


def format_retrieved_for_prompt(
    results: List[SearchResult],
    include_raw_top_n: int = 0,
    max_raw_chars: int = 2000,
    max_summary_chars: int = 220,
) -> str:
    """
    Build the string to inject into the model context.

    Default (long-context / many-hit mode): **chunk_id + short summary + source chat** only.
    Full chunk text lives in the vector store; resolve by id via GET /memory/chunks?ids=...

    If include_raw_top_n > 0, the top N hits also include a truncated **Content:** block.
    """
    if not results:
        return ""

    lines: List[str] = [
        "Semantic memory from **other past conversations** (current thread may be excluded). "
        "Each line is a **chunk_id** you can cite; full text is **not** inlined unless a Content block follows.",
        "To load full text for specific ids (e.g. exact quotes), use **GET /memory/chunks?ids=id1,id2** (up to 25 ids).",
        "",
        "**Chunk index (id → short summary):**",
    ]
    for i, r in enumerate(results):
        summary = (r.summary or (r.raw_content or "")[:max_summary_chars] or "").strip()
        if len(summary) > max_summary_chars:
            summary = summary[: max_summary_chars - 1] + "…"
        src = (r.metadata or {}).get("source_id") or "?"
        if not summary:
            summary = "(no summary)"
        lines.append(
            f"- **chunk_id** `{r.chunk_id}` | chat `{src}` | score {r.score} | {summary}"
        )
        if i < include_raw_top_n and r.raw_content:
            content = (r.raw_content or "")[:max_raw_chars]
            if len((r.raw_content or "")) > max_raw_chars:
                content += "..."
            lines.append(f"  Content: {content}")
    return "\n".join(lines)


def run_retrieval_pipeline(
    store: VectorStore,
    openai_api_key: str,
    current_message: str,
    recent_turns: Optional[List[Dict[str, str]]] = None,
    task_state: Optional[Dict[str, Any]] = None,
    working_state: Optional[WorkingState] = None,
    active_file: Optional[str] = None,
    topic_or_entities: Optional[List[str]] = None,
    top_k: int = 10,
    include_raw_top_n: int = 3,
    min_score: Optional[float] = 0.2,
    exclude_chat_id: Optional[str] = None,
) -> tuple[str, List[SearchResult]]:
    """
    Full pipeline: build query from context → vector search → format for prompt.
    Returns (context_string_to_inject, list_of_search_results).
    """
    query_text = build_retrieval_query(
        current_message=current_message,
        recent_turns=recent_turns,
        task_state=task_state,
        active_file=active_file,
        topic_or_entities=topic_or_entities,
    )
    results = retrieve(
        store=store,
        openai_api_key=openai_api_key,
        query_text=query_text,
        top_k=top_k,
        min_score=min_score,
        exclude_source_id=(
            exclude_chat_id.strip()
            if exclude_chat_id and str(exclude_chat_id).strip()
            else None
        ),
    )
    context_str = format_retrieved_for_prompt(
        results,
        include_raw_top_n=include_raw_top_n,
        max_summary_chars=max_summary_chars,
    )
    return context_str, results
