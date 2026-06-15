<div align="center">

<img width="320" alt="Obi logo" src="https://github.com/user-attachments/assets/a94f7e4c-bb29-4d18-8ab9-c25fe6a31e35" />

# Obi (Personal Vault)

**Local-first project context engine for developers.**
Index your code and files, retrieve only what matters, and feed high-signal context into your AI workflows.

[Demo Video](https://www.youtube.com/watch?v=r7eSFDm4Wd4)  · [Storyboard](https://sadly-camp-78163766.figma.site)

</div>

---

## What It Is

Your AI coding assistant re-scans your entire repo on every prompt. That is slow, expensive, and a big reason it hallucinates.

Obi fixes that. It turns your project files (code, docs, PDFs, images with OCR, spreadsheets) into a searchable context layer that runs entirely on your machine. Instead of re-sending an entire repo to an assistant each time, Obi retrieves high-signal chunks and packs targeted context for tools like Cursor or a local LLM.

The result is faster, cheaper, and more private project-aware assistance, with better grounding in your actual codebase.

---

## Demo (Head-to-Head with Cursor)

[![Obi demo video](https://img.youtube.com/vi/r7eSFDm4Wd4/maxresdefault.jpg)](https://www.youtube.com/watch?v=r7eSFDm4Wd4)

The 30-second story:

1. Ask Cursor a project question with no extra context (baseline).
2. Ask the same question with Obi context retrieval enabled.
3. Watch the speed and quality difference, with cited sources from the retrieved files.

---

## Working Product

<img width="806" alt="Obi product screenshot" src="https://github.com/user-attachments/assets/ed070acc-bda3-4a8c-bc73-0d78285cb910" />

---

## Architecture

<img width="806" alt="Obi architecture, Mac-tier and GX10-tier" src="https://github.com/user-attachments/assets/aae8caf6-4514-4d5b-8f52-538bb97ffb90" />

- **Mac-tier (developer laptop):** Electron + React app, local indexing, SQLite + vector search, local OCR and embedding pipeline, private on-device retrieval.
- **GX10-tier (higher-throughput target):** same retrieval contract, scaled model serving and indexing throughput, larger context windows, concurrent query support.
- **Shared abstraction:** query-intent routing plus a context packer layer, so both tiers produce compatible context bundles for assistants.

---

## Built With (BuilderShip Stack)

Obi started fully local. For the BuilderShip hackathon it runs as a hybrid: local-first retrieval on-device, with sponsor infrastructure handling the heavier workloads and agent surface.

- **Nebius** for scalable inference and compute on the heavier embedding and generation workloads, while indexing stays local.
- **Composio** to expose Obi as a tool any agent can call.
- **Tavily** to extend local retrieval with live web search when the answer is not on disk.

The local-first contract stays intact. Your codebase never has to leave your machine for retrieval; the cloud tier only handles compute you opt into.

---

## Core Capabilities

- **Multimodal indexing:** text, code, images, PDF, and XLS/XLSX metadata-text extraction.
- **Hybrid retrieval:** lexical (`FTS5`) + semantic (`sqlite-vec`) + image embedding retrieval, fused into a single ranking.
- **Query intent routing:** image-centric questions route to the image path; text-in-image requests route through OCR.
- **Local-first execution:** embeddings, retrieval, and context packing run on-device.
- **Source-aware UX:** indexed file metadata, skip history, and per-file unindex controls.

---

## Obi to Cursor Context Handoff

**Status:** v1 shipped (clipboard + standalone MCP server). Vector-aware MCP and embedded HTTP transport in design.

The goal is to let Cursor and other IDE agents request a compact, ranked context bundle from Obi over a stable contract, instead of re-scanning the repo every prompt.

Pieces in place:

- **Context packer** (`local-rag/src/utils/contextPacker.ts`) turns top-K `SearchResult` chunks into a budgeted bundle. Per-modality formatting: text and code include content; image items expose an absolute path so the agent can attach the file itself.
- **Copy as Cursor context** button in the chat retrieval panel writes the packed Markdown to the clipboard. Works with any agent that accepts pasted context.
- **Standalone MCP server** (`local-rag/mcp-server/`) over stdio transport, exposing `obi_search(query, limit?)` to Cursor and Claude Desktop. Reads the same `app.db` Obi writes to (lexical FTS + filename match in v1; vector search lives in the Obi app for now). See [`local-rag/mcp-server/README.md`](local-rag/mcp-server/README.md) for `~/.cursor/mcp.json` wiring.

Next steps:

- Embedded HTTP/SSE MCP transport inside Electron, so semantic vector retrieval is available to MCP clients while Obi runs.
- Optional OCR and caption inlining for image items in the bundle.
- File-export "save bundle as .md" UI action.

Out of scope for v1: multi-repo federation, remote sync, write-back from Cursor.

---

## How Data Flows

1. Ingest files from selected folders or manually picked files.
2. Normalize and parse content (text / PDF / spreadsheet / image embedding).
3. Chunk text-like content.
4. Embed chunks and store vectors.
5. Persist metadata and lexical index.
6. At query time, fuse ranked results and pack a context bundle for the assistant.

---

## Storage Model (SQLite, Local-First)

Obi uses **SQLite** as local storage inside the app data directory on your machine.

- Persistent local storage, not temporary memory.
- Free and embedded, with no separate DB server to install.
- Ideal for single-user desktop apps with strong local privacy.

**SQLite vs PostgreSQL:** SQLite is an embedded file DB with zero admin, ideal for local desktop apps but limited on multi-client write concurrency. PostgreSQL is a networked client-server DB, better for multi-user backends and heavy concurrent writes, but it requires provisioning and operations. For Obi's local-first desktop architecture, SQLite is the right default.

**Indexed data surfaces:**

- `documents` + `chunks` + `chunks_fts` + `chunk_embeddings` for text and code-like docs
- `image_documents` + `image_embeddings_clip` for images
- `gmail_messages` + `gmail_sync_state` for Gmail metadata MVP
- `index_skip_events` for skip history and diagnostics (with retention cap)

---

## Research Connection

Obi is connected to ongoing research on retrieval quality, context efficiency, and human-AI coding workflows.

> Obi evaluates whether local, intent-aware retrieval can improve assistant response quality while reducing token and context overhead.



---

## Setup

### Prerequisites

- Node.js `^22.13.0`
- npm
- macOS or Windows

### Quick Start (macOS)

```bash
git clone https://github.com/himavanthkar/Personal_Vault.git
cd Personal_Vault/local-rag
npm install
npx electron-rebuild
# place required .gguf model files in local-rag/resources/models
npm run dev
```

### Build and Lint

```bash
cd local-rag && npm run build
cd local-rag && npm run lint
```

### Notes

- If macOS blocks local binaries (for example `llama-server`), sign or trust the binaries before running.
- Windows setup for llama.cpp binaries is documented in `local-rag/README.md`.

---

## Repo Layout

- `local-rag/src` — renderer UI (React)
- `local-rag/electron` — Electron main process, indexing, retrieval, vector store
- `local-rag/resources` — local models and runtime binaries

---

## More Documentation

- App setup and platform notes: [`local-rag/README.md`](local-rag/README.md)
- Focus mode technical notes: [`local-rag/TECHNICAL_NOTES_FOCUS_MODE.md`](local-rag/TECHNICAL_NOTES_FOCUS_MODE.md)
- Hackathon overview: [`local-rag/HACKATHON_TECH_OVERVIEW.txt`](local-rag/HACKATHON_TECH_OVERVIEW.txt)
- Design notes, future work, generation-verification gap, verifier agents: [`local-rag/DESIGN_NOTES.md`](local-rag/DESIGN_NOTES.md)
- Cursor MCP server (stdio): [`local-rag/mcp-server/README.md`](local-rag/mcp-server/README.md)

---

## Recruiter Snapshot

- Built a local-first AI context system for project-aware development workflows.
- Implemented hybrid retrieval over mixed file types, including OCR-backed image support.
- Currently implementing Cursor context handoff (retrieval to context packer to adapter).
- Designed toward assistant handoff: retrieve once, send compact context, avoid repeated full-repo scans.
