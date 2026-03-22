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

## Requirements

- **`OPENAI_API_KEY`** — embeddings (and chat) use OpenAI for this pipeline even if the chat model is xAI.
- **`pip install chromadb`** / `poetry add chromadb`

If Chroma fails to load, the backend falls back to the old **in-memory** `VectorStore` (no cross-restart persistence).

## Better than raw RAG?

This **is** standard RAG (retrieve → inject). Improvements to consider later:

- **HyDE** or **query expansion** for better recall on vague questions.
- **Recency + similarity** hybrid scoring (Chroma metadata: `updated_at` per chunk).
- **Summarization tier**: store short summaries in metadata and expand only top hits to full text (token budget).
- **Deduplication** across near-identical chunks.

For your “apples again a month later” case, **semantic chunk retrieval + exclude current chat** is the right baseline.
