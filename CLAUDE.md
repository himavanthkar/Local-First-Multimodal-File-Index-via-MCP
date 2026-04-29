# CLAUDE.md

## Project
Obi is an Electron desktop personal vault/RAG app that indexes local files (text, PDFs, images, OCR) so users can search and chat over their own data.
Primary goal: make querying fast and context-aware by using a local retrieval layer that prepares relevant project context before handing it to coding assistants (for example Cursor), instead of re-reading the full project each time.

## Stack
Electron + React + Vite + TypeScript, SQLite (`better-sqlite3` + `sqlite-vec`), local embedding/OCR tooling (`@xenova/transformers`, `tesseract.js`, `sharp`), packaged with `electron-builder` for desktop distribution.

## Commands
- Dev: `cd local-rag && npm run dev`
- Build: `cd local-rag && npm run build`
- Test single: `Not configured yet (add a test runner first)`
- Test all: `Not configured yet (add a test runner first)`
- Lint: `cd local-rag && npm run lint`
- Type check: `cd local-rag && npx tsc --noEmit`

## Architecture
- `local-rag/src` -> React renderer UI (chat, vault interface, user-facing flows)
- `local-rag/electron` -> Electron main-process logic (indexing, vector store, file processing, app orchestration)
- `local-rag/resources` -> Runtime assets and local model/binary resources
- `local-rag/electron/vectorStore.ts` -> Hybrid retrieval and ranking logic for text/image search

## Rules
- Always `cd local-rag` before running npm commands; root folder has no app scripts.
- Do not remove or reset unrelated local changes unless the user explicitly asks.
- Before any git command with side effects (`commit`, `push`, `rebase`, `reset`), explain purpose, expected result, and actual result.
- IMPORTANT: If the same error repeats, switch strategy instead of repeating uninstall/reinstall loops.

## Workflow
- Start with quick repo checks (`git status`, relevant file reads), then implement directly unless user asks for planning.
- Commit conventions: concise, outcome-focused messages (imperative or sentence style), include why in body when needed.
- Testing expectations: run lint/type-check/build paths impacted by edits; if full tests do not exist, report that clearly.
- Ask vs act: act by default on clear requests; ask only when requirements are ambiguous, risky, or destructive.
- Current status: remote `origin` now points to `https://github.com/himavanthkar/Personal_Vault.git` and branch `chore/image-ocr-object-detection-routing` has been pushed there.
- Next actions for user: open a PR from `chore/image-ocr-object-detection-routing` to your target base branch, and decide whether `.DS_Store` should remain tracked.

## Future enhancements
- Add query-intent routing that decides when to answer from local index vs when to call a local LLM for synthesis.
- Build a "context packer" that sends only top relevant chunks/files to Cursor to reduce repeated full-project context loading.
- Add conversational memory/session state so follow-up queries reuse prior context windows and retrieved evidence.
- Introduce retrieval quality metrics (precision@k, latency, hit-rate by file type) and a lightweight eval dataset.
- Add incremental indexing and background watchers for changed files to keep retrieval fresh with low overhead.
- Add source-grounded citations in responses (file path + chunk IDs) for trust and easier debugging.

## Resume notes
- Built an Electron + React local RAG desktop system for project-aware querying across text, PDF, and image/OCR content.
- Implemented hybrid retrieval and ranking over SQLite/`sqlite-vec`, including image filename-aware matching.
- Improved indexing controls to keep key assets (PDFs/images) searchable even when ignored by repository rules.
- Integrated local-first data flow to reduce dependency on external services and keep sensitive project data on-device.
- Designed the foundation for agent-context handoff so coding assistants can receive targeted context instead of full repository scans.

## Out of scope
- Do not modify generated build outputs in `local-rag/dist` and `local-rag/dist-electron` manually.
- Do not change local machine-specific binaries/models in `local-rag/resources` unless explicitly requested.
- Do not reconfigure git remotes/branch history (force-push/reset/rewrite) without explicit user approval.
