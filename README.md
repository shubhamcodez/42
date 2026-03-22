# JARVIS

Assistant that can chat, control the **desktop** (screenshot + vision + pyautogui—including your on-screen browser), run **sandboxed Python**, optional **host shell** (opt-in), and **market data / analysis** via **yfinance** (finance agent). Routes via a supervisor LLM; supports OpenAI and xAI (Grok).

---

## Core idea: self-improving agents through evals

The agent improves over time by **looping through evals** and turning results into **prompt and code changes**:

1. **Trace every run** — Each chat and agent run is logged (provider, route, success, tokens, errors) to `jarvis-observability/traces/`.
2. **Generate evals from logs** — An LLM turns recent traces into multi-turn evaluation cases (coherence, task completion). Stored in `jarvis-observability/evals/`.
3. **Run evals for all models** — Each case is run with both OpenAI and xAI; optional LLM judge scores replies. Pass@1 per model is recorded.
4. **Optimization step** — Aggregates trace stats + eval pass rates, then asks an LLM for:
   - **Prompt modification instructions**: what to add or change in the supervisor, desktop, coding, shell, finance, or chat prompts (with reasons).
   - **Code addition suggestions**: which file and what logic/code to add (e.g. retries, validation), with reasons.

You (or a future automation layer) apply those instructions and suggestions; the next runs and evals reflect the improvements. So: **evals → scores → optimization → prompt/code suggestions → apply → better agents**.

---

## Memory: cross-chat RAG + broader plan

**Implemented:** Past **user/assistant** chat turns are embedded and stored in **Chroma** (`jarvis-chroma/` by default). New assistant messages trigger re-index of that chat; semantic search pulls relevant **other** conversations into context on **chat** turns. See **`backend/MEMORY.md`**.

**Planned beyond chats:** docs, code symbols, summary tier, working state.

**Four stores (target architecture)**

- **Raw chunk store** — `chunk_id`, `content`, `source_type` (chat, code, doc, note), `source_id`, `created_at`, `version`, `metadata`. Persistence for all ingested content.
- **Vector index** (**Chroma** for chats today) — `chunk_id`, `embedding`, lightweight metadata filters. Fast semantic retrieval.
- **Summary store** — `summary_id`, `chunk_id` or `parent_id`, short summary, structured facts/entities/decisions. Prompt-ready compression.
- **Working state store** — Current task, active files, recent decisions, unresolved questions, last retrieved memory set. Per-session continuity.

**Chunk IDs vs context (long chats / many hits)**

- Each stored unit has a stable **`chunk_id`** (e.g. `1774150673:0:4` = chat id + turn window). **Chroma** keeps the mapping **chunk_id → full text + metadata** (the document body).
- In the **LLM system prompt**, retrieval lists **chunk_id + short summary + source chat + score** by default — **not** the full chunk body — so token use stays bounded even with long histories.
- When exact wording or deeper context is needed, resolve ids with **`GET /memory/chunks?ids=id1,id2`** (returns full `content` for those chunks). Optional: set **`JARVIS_MEMORY_RAW_CHUNKS=N`** to inline the top *N* hits’ full text in the prompt (see `backend/MEMORY.md`).

**Chunking**

- **Chats:** Windowed turns (currently 4 messages per chunk for indexing), preserve speaker lines. Metadata includes `source_id` (chat file id).
- **Docs:** Headings/sections first, then paragraph windows; ~10–20% overlap.
- **Code:** By file, class, function, method, config/schema block (not plain text). Metadata: `file_path`, `symbol_name`, `symbol_type`, imports/exports, line range, repo version.

**Flow**

- **Ingestion:** Parse → chunk → enrich metadata → embed → write to vector DB (Chroma stores id ↔ document mapping).
- **Retrieval:** Embed query → vector search → build prompt line **per chunk_id** (summary-first); expand full text only for top N if configured or via API.
- **Prompt assembly:** System + current request + **chunk index** (ids + short summaries) + optional inline bodies + task state; token budget stays under control.
- **After each turn:** Update working state; write back only important turns (decisions, facts, artifacts) to avoid clutter.

Chroma is used for **chat** vectors and the **chunk_id → content** mapping; the rest of the pipeline above is the long-term direction.
