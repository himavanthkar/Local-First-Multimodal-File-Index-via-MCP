# Obi — Design Notes, Honest Review, Future Work

A working journal of decisions, trade-offs, and unresolved gaps for Obi.
Kept deliberately blunt so future me (and reviewers) can use it for thinking,
not marketing. If something here disagrees with the main `README.md`, this
file is closer to the truth.

Last refreshed: 2026-05-02.

---

## 0. Origin & direction (start here)

### 0.1 The original one-line idea

> **"Stop re-sending my whole project to a coding assistant. Index it
> locally, and only hand the assistant the chunks that actually matter."**

Everything else (PDF support, image OCR, Cursor MCP, verifier ideas) is a
consequence of taking that single sentence seriously.

### 0.2 What "where we are" actually means today

- **Indexing** is multimodal (text, code, PDFs, images) and runs entirely
  on-device.
- **Retrieval** is hybrid (vector + FTS5 + image CLIP) inside the Electron
  app.
- **Hand-off to coding assistants** has two real paths:
  1. **Clipboard**: `Copy as Cursor context` button packs Markdown the
     user pastes anywhere.
  2. **MCP server (stdio)**: `local-rag/mcp-server/` — Cursor (or Claude
     Desktop) calls `obi_search(query)` on its own when the IDE agent
     decides it needs project context. Lexical-only in v1.
- **No verifier loop** anywhere yet. We're still pure generator-side
  helper. See § 6 / § 7 for where verifier agents plug in.

### 0.3 How the MCP server is "switched on" (no daemon involved)

Plain words: there is **no** "Obi running an MCP server in the background".
The MCP server is a small Node script. Cursor **spawns it on demand** the
moment it needs to call a tool, and shuts it down when the chat is over.

The only one-time setup is editing **`~/.cursor/mcp.json`** (created if it
doesn't exist):

```json
{
  "mcpServers": {
    "obi": {
      "command": "node",
      "args": ["/Users/abhil/Desktop/Obi_Laptop/local-rag/mcp-server/dist/index.js"]
    }
  }
}
```

Then **restart Cursor** once. From that moment:

- The Obi UI does **not** need to be open.
- We don't need to "start the server" — Cursor starts it per session.
- To *disable* it, comment out / delete that JSON entry and restart Cursor.
- To *update* it after editing source: from `local-rag/mcp-server`, run
  `npm install && npm run build`. Cursor will pick up the new `dist/`
  next time it spawns the process.

So practically: do you switch it on now or later?

- **Now is fine** if you want to dogfood. Worst case it's noise — Cursor
  will only call it when it thinks it's useful, and the tool's results
  show up as a tool response in the chat (you can always ignore them).
- **Later is fine** if you want to first add an embedded HTTP MCP variant
  with semantic vectors (P2 in § 5) so Cursor sees the *richer* index
  from day one.

Both work; this is reversible by editing one JSON file.

### 0.4 Where we are pointed (next 4–8 weeks)

In rough order of leverage:

1. **Eval harness** so future changes are measurable, not vibes (P0 in § 5).
2. **Honest PDF status** — distinguish "scanned, no text" vs "extraction
   failed" in the UI (P0).
3. **Re-ranker on top of hybrid retrieval** (P1).
4. **Embedded HTTP/SSE MCP transport** so semantic vectors are exposed to
   Cursor (P2). At that point the standalone stdio server becomes the
   "Obi closed" fallback.
5. **Verifier agents** (§ 7). Citation enforcement first; everything else
   stacks on it.

This is intentionally sequential: each step makes the next step's
measurement possible.

### 0.5 Pivot levers (cheap → expensive)

The product can pivot without redoing the index. From smallest to largest:

| Lever | What it changes | Cost |
|---|---|---|
| Tighten / disable visual-intent routing | Fewer image hits in chat | Hours |
| Add metadata filter (`modalities`, paths) to the chat + MCP tool | Better precision per query | Hours–day |
| Ship a real eval (queries → expected sources) | Honest before/after for any change | Day–two |
| Add citation verifier in renderer + as MCP tool `obi_verify_grounding` | First measurable hallucination guardrail | 2–3 days |
| Embedded HTTP/SSE MCP w/ live `vectorStore.search` | Cursor gets semantic + lexical + image | Week |
| Scanned-PDF OCR path (PDF → page raster → TrOCR → index) | Closes the biggest "Obi can't see this" gap | Week–two |
| Move from "personal vault" to "team vault" (multi-repo, shared index) | Different product. Not recommended for the thesis arc | Months |

Heuristic for picking: any pivot in the top half of this table improves
**accuracy or honesty**; the bottom half changes **scope**. For the CS
298 thesis arc, stay top-half until the verifier story is publishable.

### 0.6 Pivots we should not take

- Cloud embedding / cloud retrieval. Breaks the local-first promise.
- Write-back from the assistant into the index. Different security model.
- Building our own model. We are a retrieval + verification project, not
  a foundation-model project.

---

## 1. What this document is

- A **timeline of decisions** taken in recent sessions, with the reason
  attached so we don't re-litigate them.
- A **per-area review** of indexing, retrieval, PDF handling, code handling,
  the Cursor handoff, and the new MCP server.
- A **brutally honest list** of weaknesses I would not put in the README.
- A **research bridge** to the CS 298 *generation–verification gap* and how
  verifier agents could plug into Obi.
- A **prioritized future-work** queue.

---

## 2. Recent decision timeline (most recent first)

### 2.6 Stand up a standalone MCP server (this session)

- **What**: `local-rag/mcp-server/` (separate `package.json`, builds to
  `dist/index.js`). One tool: `obi_search(query, limit?)`. Stdio transport.
  Reads the same `app.db` Obi writes.
- **Why standalone, not embedded**: the user wanted Cursor connectivity that
  works even when the Obi UI is closed. A standalone Node process can read
  the SQLite file directly. We pay the cost of duplicating the context
  packer (kept in sync explicitly).
- **Why FTS-only in v1**: the embedding sidecar (llama.cpp) is owned by the
  Electron main process. Loading another copy of the model in the MCP
  process would double memory and ABI risk. Lexical FTS5 + filename match
  is "good enough to be useful" while we plan an embedded HTTP/SSE MCP.
- **Verified**: live JSON-RPC `initialize` + `tools/list` + `tools/call`
  against the user's real `~/Library/Application Support/Obi/rag/app.db`
  returned a real result for `f1040`.

### 2.5 Context packer module + Copy as Cursor context (this session)

- **What**: `local-rag/src/utils/contextPacker.ts` — pure module, no React /
  Electron deps. `packContext(results, options)` → `{ bundle, markdown }`.
  Per-modality formatting (text/code includes content; images expose a path
  + an "open or attach the file" hint). Token budget = per-item char clamp,
  then drop low-rank items until total fits.
- **Why pure**: same code can be reused by the renderer, by the in-app chat
  prefix, and (a duplicated copy of) by the MCP server. Avoids IPC just to
  pack a string.
- **Why expose images by path, not OCR-inlined**: in v1 the agent can simply
  attach the image file (Cursor / Claude Desktop both accept paths or files
  via tool results). Inlining captions/OCR is a quality-vs-cost trade we can
  add behind an opt-in.
- **UI**: `Copy as Cursor context` icon in the chat retrieval panel —
  zero-risk transport, no agent integration required.

### 2.4 Made code indexing actually cover the codebase

- **Symptom**: `server.cjs`, `index.html`, etc. were skipped with
  `unsupported_modality`.
- **Root cause**: tiny `CODE_FILE_EXTENSIONS` set, picker hardcoded
  `includeCodeFiles: false`, modality logic duplicated in three places.
- **Fix**: centralized `resolveFileModality` and `shouldChunkAsCode` in
  `local-rag/electron/indexingRules.ts`. Expanded code extensions and added
  basename overrides for ambiguous names (`Dockerfile`, `Makefile`, lock
  files, etc.). Default `includeCodeFiles` flipped to `true`. Removed the
  duplicated `inferModality` from `vectorStore.ts` and its stale SQL `GLOB`
  list in `getRecentIndexedFiles`.

### 2.3 PDF text-only realism

- **Symptom**: chat could only "see" `f1040.pdf` filename and title.
- **Root cause** (real, in the code): `safeReadTextFile` runs `pdf-parse`
  and on **scanned** or **image-only** PDFs returns no usable text.
  `buildPdfIndexText` synthesizes a metadata line so the file remains
  findable; that becomes the only chunk content.
- **Behavior change**: added an explicit `[Obi PDF note: ...]` so a future
  answer can plainly explain *why* the body is empty after re-indexing.
- **Did not** add OCR / page rasterization to the PDF path; explicitly
  parked as future work.

### 2.2 Plan-mode discipline

- We treated planning as planning: drafted the Cursor handoff plan, parked
  it in the README under a "Roadmap (Currently Implementing)" section, and
  only moved to execution when the user said "implement".

### 2.1 Architecture clarification

- **Mental model that ended up being correct**: PDFs and code are *not*
  separate retrieval stacks. Both flow through `indexTextFile` →
  `documents` / `chunks` / `chunk_embeddings` / `chunks_fts`. Only images
  use a parallel pipeline (`indexImage` → `image_documents` /
  `image_embeddings_clip`). This is the right shape for the current scope.

---

## 3. Per-area review

### 3.1 Indexer

**Working**

- Single source of truth for path → modality
  (`indexingRules.resolveFileModality`).
- Basename overrides handle `Dockerfile`, `CMakeLists.txt`, lock files.
- Code-aware chunker has function/class boundary heuristics; markdown
  chunker is heading-aware.
- Default text path (PDF, txt, md, csv, json, yaml, etc.) is consistent.

**Weak**

- The `documents` table does not persist `modality`. We re-derive it from
  the path each time we render stats / recent files. Cheap, but means every
  consumer must re-run the rule. If we ever change the rule, history
  appears to "shift".
- `inferModality`-style logic was duplicated for a long time; we collapsed
  it but every new caller is one missed import away from drift.
- Many file types still fall under "sliding window" chunking. CSVs and
  JSON-lines aren't chunked structurally — large rows can be split badly.
- No incremental cost tracking. We don't know per-folder how many files we
  drop, why, or how that ratio shifts after rules change.

### 3.2 PDF handling

**Working**

- Text-based PDFs index correctly via `pdf-parse`'s `PDFParse.getText()`.
- Filename + title fallback keeps scanned/empty PDFs at least *findable*.
- An explicit "no extractable text" note now lands in the chunk so the
  model can say plainly that the PDF had no text layer.

**Weak**

- No OCR fallback for scanned PDFs (Obi already has OCR for images via
  TrOCR — it is *not* wired through the PDF path).
- No layout-aware parsing. Multi-column / table-heavy PDFs get garbled
  chunks because we slide a window over a flattened text stream.
- Errors in extraction are caught and silently turned into `""`. So a
  parser/runtime failure is indistinguishable from "scanned PDF". The user
  has to read the Electron logs to tell them apart.
- `pdf-parse` is **not** declared `external` in `vite.config.ts` (unlike
  `sharp` / `onnxruntime-*`). Bundling its `pdfjs-dist` worker / wasm
  paths through Vite is fragile — one Electron upgrade can quietly break
  *every* PDF.

### 3.3 Code handling

**Working**

- `CODE_FILE_EXTENSIONS` covers JS/TS family, mainstream languages, web
  markup/styles, shells, infra (`tf`, `proto`, `graphql`, ...).
- Basename overrides for unambiguous "this is code even if the extension
  says otherwise" (`Dockerfile`, `CMakeLists.txt`, lock files).
- Function/class boundary chunker prefers semantically meaningful breaks.

**Weak**

- The boundary regex is heuristic. Languages with unusual syntax (Lisp
  family, Haskell, Erlang) fall back to dumb sliding windows.
- We don't track *language* — only "kind=code". Downstream we can't
  preferentially weight a TypeScript hit over a Markdown hit when the
  query is clearly code.
- Imports / call graph aren't used. We treat each file as a bag of chunks.

### 3.4 Hybrid retrieval

**Working**

- `vectorStore.search` runs text vector + FTS5 + image CLIP and merges via
  RRF with a "visual query" weighting.
- `findImageRowsByFilenameQuery` lets users say "show me X.png" and get the
  exact image even when CLIP would miss.

**Weak**

- The "visual query" detector (`isLikelyVisualQuery`) is keyword-based and
  trips on common informational phrases. We over-rotate to image results
  for innocuous questions.
- RRF weights are static constants (`textSemanticWeight`,
  `textLexicalWeight`, `imageWeight`). No calibration or per-query budget.
- No re-ranker. After RRF we just take the top-K; we don't, say, run a
  cross-encoder over the top 50 to rescore.
- No metadata filtering. There's no way for a query (or the MCP tool) to
  say "only PDFs in /Tax/" or "exclude images" — we'd just return the
  union and let the agent ignore the noise.

### 3.5 Cursor handoff

**Working**

- Two transports today:
  1. **Clipboard** via the `Copy as Cursor context` button. Zero
     integration risk.
  2. **Standalone MCP server** over stdio. Pulls when Cursor's agent
     decides. Lexical-only.
- Same packer shape on both sides; same "Source N (kind): file / Path /
  Section / Content" format. Image items expose absolute paths so the
  agent can attach files itself.

**Weak**

- MCP v1 is **lexical-only**. The semantic richness lives in Electron and
  is not exposed to MCP yet. Cursor will under-recall on conceptual
  queries.
- Token budget is char-based with a 4-chars-per-token estimate. Real
  tokenization would be more honest, especially when packing for very
  small contexts.
- The MCP packer is a literal copy of the renderer packer. Drift risk.
  Long-term we should ship `contextPacker` as a tiny shared workspace
  package.
- No telemetry on what Cursor actually called and what it did with the
  result. We're flying blind on whether the tool is useful.

### 3.6 Chat / RAG prefix

**Working**

- `buildRagContextPrefix` now delegates to `packForChatPrefix`, so the
  in-app chat and the external Cursor copy share the same shape.

**Weak**

- The system prompt still claims "if image captions are included, treat
  them as visual evidence" — but our v1 image items deliberately do not
  inline captions. The system prompt over-promises.
- No "abstain" instruction. The model isn't told explicitly that returning
  nothing is acceptable when context is too thin.

### 3.7 UX / signals

**Working**

- Per-file `index_count`, recent files, skip events with retention.
- "Choose files" picker lets the user index outside their watched folder.

**Weak**

- "0 code" is still confusing for first-time users. We added auto-default
  `includeCodeFiles: true`, but there is no visible toggle, so a user who
  *does* want to exclude code can't.
- No "what would change if I re-indexed?" preview. Re-index is a one-shot
  rebuild.

---

## 4. Brutally honest opinion

I'd write this once if Obi were code I shipped to my team:

- The product story ("retrieve once, hand context to Cursor") is clean and
  the code is **small enough to explain**. That's a real strength.
- The retrieval is *not* state-of-the-art. It's BM25 + a vector search +
  CLIP filename matching + a hand-written merge. That's a fine baseline,
  but please stop calling it "advanced retrieval" in slides until we add a
  re-ranker, structural chunking, and a real eval.
- PDF handling is the most over-claimed area. We say "Obi indexes PDFs";
  in practice we index *the text layer* of PDFs. Anything scanned is name
  + a note. We should either (a) ship OCR-on-PDF, or (b) say "text PDFs
  only" plainly in marketing.
- "Visual intent" routing is the single feature most likely to make a
  reviewer think the system is buggy. It promotes images on innocuous
  questions. It needs to be either narrower or behind an explicit toggle.
- The MCP server is the most useful thing we built recently. It is also
  the one most likely to grow into something you don't want to maintain
  (HTTP transport, multi-workspace, write-back, auth). Keep it small and
  resist scope creep.
- There is **no test suite**. CLAUDE.md admits it. For a system whose
  selling point is "honest grounding", that's a research-credibility
  problem more than an engineering one.

---

## 5. Future work, prioritized

**P0 — credibility / correctness**

1. Eval harness: a tiny labeled dataset (queries → expected source files /
   chunks). Track precision@5, MRR, time-to-first-chunk per modality.
   Without this we cannot honestly compare changes.
2. Explicit "extraction failed vs no text layer" status per PDF, surfaced
   in the Files screen. Stop hiding parser errors behind `""`.
3. Externalize `pdf-parse` (and `pdfjs-dist`) in `vite.config.ts` to stop
   bundle-time fragility. Mirror the `sharp` pattern.

**P1 — retrieval quality**

4. Light-weight cross-encoder re-rank on the top 30 fused results.
5. Replace the keyword-based `isLikelyVisualQuery` with either:
   (a) a small classifier, or
   (b) an explicit `modalities: ["text" | "image" | "code"]` filter the
       caller passes (chat UI + MCP tool).
6. Structural chunking for CSV / JSON / Markdown tables.

**P2 — Cursor handoff depth**

7. Embedded HTTP/SSE MCP transport inside Electron, sharing the live
   `VectorStore.search` (semantic + lexical + image). Standalone stays as
   the "Obi closed" fallback.
8. MCP tool variants:
   `obi_open(path)`, `obi_list_recent(modality?)`, `obi_grep(pattern)`.
9. Token-aware packer using a real tokenizer (e.g. tiktoken-equivalent for
   the local llama model).

**P3 — PDFs**

10. Scanned-PDF OCR path: render pages with `pdfjs` → run TrOCR → index as
    text. Cap pages per file, cache by mtime.
11. Optional layout-aware parser (e.g. `pymupdf4llm`-equivalent in Node) for
    multi-column documents.

**P4 — verifier agents (see § 6)**

---

## 6. Bridge to CS 298: the generation–verification gap

> Add the canonical thesis link here:
> `[CS 298 thesis / report URL]`
> `[Grad Slam page URL]`
> `[Any preprint / poster URL]`

The thread we care about is the **generation–verification gap**: modern
LLMs *generate* fluent answers far faster than any pipeline *verifies*
them. Retrieval reduces (but does not close) the gap. RAG provides
*evidence the generator could have used*; it does not check whether the
generator actually used it correctly.

Obi today is squarely a **generator-side helper**. It packs context and
hands it to Cursor / a local llama. It has no verifier in the loop. That
mirrors the gap exactly: we make hallucination *less likely* by giving
better evidence; we never make it *detectable*.

A research-credible Obi would close part of that gap on its own machine,
without needing a frontier LLM or a cloud verifier:

1. **Citation enforcement**. Every claim in the answer must point at a
   `chunk_id` in the bundle. An answer that cites nothing — or cites a
   chunk that doesn't contain the claim — is rejected or marked
   "ungrounded" before it leaves the app.
2. **Coverage check**. Before answering, the generator commits to a list
   of "I will need facts F1..Fn". A verifier checks that retrieval
   contains evidence for each Fi. If not, abstain or re-query.
3. **Self-consistency / paraphrase consensus**. Re-issue the query with k
   paraphrases; require the same answer (or the same cited chunks) above a
   threshold.
4. **Calibration / abstain**. Output an `unknown` token explicitly when
   verifier signals are weak. This is the single highest-impact step for
   reducing measured hallucination.

The clean way to phrase Obi's research contribution against the gap:

> *"A local-first retrieval substrate plus a layered verifier that rejects
> ungrounded generations, evaluated on a labeled corpus of project
> queries."*

The "verifier" is the part that distinguishes this from another RAG demo.

---

## 7. Verifier agents — concrete next-step ideas

Each of these is small enough to prototype as a single tool call from the
agent or as a post-processing pass over the model's output.

### 7.1 Citation verifier (P0)

- Force the answer format to include `[chunk:<id>]` markers.
- After streaming completes, walk the markers; for each one, fetch the
  chunk text and run a cheap NLI / lexical containment check against the
  surrounding sentence.
- Returns a per-sentence grounding score; sentences below threshold get
  flagged in the UI ("not grounded in retrieved context").

### 7.2 Code verifier (P1)

- If the answer contains code blocks, run a language-aware syntactic check
  (parser only, no execution).
- Optional: for short snippets in JS/TS/Python, run them in a constrained
  sandbox with a timeout.
- Returns "syntactically valid" + "executes without error" booleans.

### 7.3 Numeric / extracted-fact verifier (P1)

- Heuristic extractor pulls numbers, dates, named entities from the
  answer.
- For each, search the retrieved chunks for the same value with a small
  context window. Flag mismatches.
- Cheap, high signal for spreadsheet / PDF questions.

### 7.4 Retrieval coverage verifier (P0)

- Before generation, ask the model to list "claims I will need" as a JSON
  array.
- For each claim, run an Obi sub-search and check that something was
  returned above a similarity threshold.
- If coverage < threshold, surface "low coverage" to the user and offer to
  expand retrieval (more files / different modalities / re-index).

### 7.5 Self-consistency check (P2)

- For factual queries, generate k=3 answers at low temperature with
  paraphrased prompts.
- Reject if more than one answer disagrees on cited facts.

### 7.6 Where the verifiers live

- Closest to the user: in the Electron renderer, post-stream hook on
  `llama:chat_stream_done`.
- Closest to Cursor: as additional MCP tools (e.g. `obi_verify_grounding`)
  that an agent calls *after* it drafts an answer. This gives any
  MCP-aware client a verifier loop without changing the client.

The MCP path is the more academically interesting one because it lets us
evaluate the gap **separately** from any one model.

---

## 8. Open questions

- Is the scope "personal vault + Cursor handoff" enough for the thesis, or
  does CS 298 need a controlled study comparing answer quality with vs
  without verifier passes?
- Do we have rights / can we redistribute the eval corpus we'd need? If
  not, we'll have to synthesize one.
- How do we handle multi-repo / multi-vault if that ever becomes a goal?
  Today the index is global per machine.
- Is there a path to a tiny **local** verifier model (small, distilled)
  that runs alongside the main llama process without the user noticing?

---

## 9. Pointers (live files)

- Indexing rules: `local-rag/electron/indexingRules.ts`
- Vector store / search / packer-of-record (in-app): `local-rag/electron/vectorStore.ts`
- Renderer packer: `local-rag/src/utils/contextPacker.ts`
- Chat prefix wiring: `local-rag/src/App.tsx` (`buildRagContextPrefix`)
- Copy-as-context UI: `local-rag/src/components/ui/FileResultsPanel.tsx`
- MCP server: `local-rag/mcp-server/src/index.ts`
- MCP server docs: `local-rag/mcp-server/README.md`

---

## 10. How to use this document

When in doubt, read § 4 first (honest opinion), then § 5 (priorities),
then § 6/§ 7 if the question is research-shaped. Keep entries short.
Append new dated decisions to § 2 above the previous ones. Move resolved
weaknesses out of § 3 once they truly are fixed; don't pretend.
