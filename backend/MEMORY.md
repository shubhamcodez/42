# Cross-chat memory (Chroma RAG)

Past **user + assistant** turns are chunked, embedded with **OpenAI `text-embedding-3-small`**, and stored in a **persistent Chroma** database (cosine similarity).

## Paths

- Default directory: **`jarvis-chroma/`** at the project root (same level as `chats/`).
- Override: env **`JARVIS_CHROMA_PATH`** → absolute or relative path to a folder.

## When data is indexed

1. **Automatic:** After each **`assistant`** message is saved via `POST /chat/append` (normal UI flow), that chat is re-ingested (replace-all chunks for that `chat_id`).
2. **Manual:** `POST /memory/ingest` with `{"chat_id": "..."}`.
3. **Bootstrap:** `POST /memory/reindex-all` — walks all chats in the configured chats directory.

## Retrieval (RAG)

On **chat** turns (not agent runs), if the store is non-empty, the backend builds a query from the current message + recent turns, searches Chroma, and injects formatted hits into **system context**.

- **Current chat is excluded** from hits so you mainly see *other* threads (e.g. “apples” from a month ago) without duplicating what’s already in the sliding history window.

### Chunk IDs in context (token-efficient)

- Chroma stores **`chunk_id` → full document** (the chunk text) plus metadata (`source_id`, `summary`, …).
- The default prompt lists each hit as **`chunk_id` + short summary + source chat + score** — **not** the full body — so long histories and many hits stay cheap in tokens.
- **Resolve full text when needed:** `GET /memory/chunks?ids=chunk_id_1,chunk_id_2` (max 25 ids). Response: `{ "chunks": [ { "chunk_id", "content", "metadata" }, ... ] }`.
- **Optional inline bodies:** set **`JARVIS_MEMORY_RAW_CHUNKS`** to `1`…`10` to append a truncated **Content:** block for the top N hits (strongest matches first).
- **Summary line length:** **`JARVIS_MEMORY_SUMMARY_CHARS`** (default `220`, max `800`).

## Requirements

- **`OPENAI_API_KEY`** — embeddings (and chat) use OpenAI for this pipeline even if the chat model is xAI.
- **`pip install chromadb`** / `poetry add chromadb`

If Chroma fails to load, the backend falls back to the old **in-memory** `VectorStore` (no cross-restart persistence).

## Better than raw RAG?

This **is** standard RAG (retrieve → inject). Improvements to consider later:

- **HyDE** or **query expansion** for better recall on vague questions.
- **Recency + similarity** hybrid scoring (Chroma metadata: `updated_at` per chunk).
- **Summarization tier**: implemented in baseline form — summaries in metadata + **chunk_id** in prompt; expand via API or `JARVIS_MEMORY_RAW_CHUNKS`.
- **Deduplication** across near-identical chunks.

For your “apples again a month later” case, **semantic chunk retrieval + exclude current chat** is the right baseline.
