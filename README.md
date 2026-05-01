# Personal Vault (Obi)

Local-first project context engine for developers: index your code and files, retrieve the most relevant context, and feed only what matters into AI workflows.

## Elevator Pitch (3 Sentences)
Personal Vault is a local RAG desktop app that turns your project files (code, docs, PDFs, images/OCR) into a searchable context layer.  
Instead of re-sending an entire repo to an assistant each time, it retrieves high-signal chunks and prepares targeted context for tools like Cursor or a local LLM.  
The result is faster, cheaper, and more private project-aware assistance with better grounding in your actual codebase.

## 30-Second Demo (Head-to-Head with Cursor)
Add your demo media here:

- GIF: `docs/demo/head-to-head.gif`
- Video: `docs/demo/head-to-head.mp4`

Suggested structure for the clip:
1. Ask Cursor a project question with no extra context (baseline).
2. Ask the same question with Personal Vault context retrieval enabled.
3. Show speed/quality difference and cited sources from retrieved files.

## Architecture (Mac-Tier and GX10-Tier Story)
Add your architecture diagram here:

- Diagram image: `docs/architecture/mac-vs-gx10.png`
- Optional source: `docs/architecture/mac-vs-gx10.drawio`

Narrative to keep in the README:

- **Mac-tier (developer laptop):** Electron + React app, local indexing, SQLite + vector search, local OCR/embedding pipeline, private on-device retrieval.
- **GX10-tier (higher-throughput target):** same retrieval contract, scaled model serving/indexing throughput, larger context windows and concurrent query support.
- **Shared abstraction:** query-intent routing + context packer layer so both tiers produce compatible context bundles for assistants.

## Research Connection
This project is connected to ongoing research on retrieval quality, context efficiency, and human-AI coding workflows.

- Thesis / write-up: `[Add thesis URL here]`
- Grad Slam page: `[Add Grad Slam URL here]`

Suggested one-liner:
"Personal Vault evaluates whether local, intent-aware retrieval can improve assistant response quality while reducing token/context overhead."

## Setup Instructions

### Prerequisites
- Node.js `^22.13.0`
- npm
- macOS or Windows

### Quick Start (macOS)
1. Clone the repository:
   - `git clone https://github.com/himavanthkar/Personal_Vault.git`
2. Enter app directory:
   - `cd Personal_Vault/local-rag`
3. Install dependencies:
   - `npm install`
4. Rebuild native Electron modules:
   - `npx electron-rebuild`
5. Place required `.gguf` model files in `local-rag/resources/models`.
6. Start development server:
   - `npm run dev`

### Build
- `cd local-rag && npm run build`

### Lint
- `cd local-rag && npm run lint`

### Notes
- If macOS blocks local binaries (for example `llama-server`), sign/trust the binaries before running.
- Windows setup for llama.cpp binaries is documented in `local-rag/README.md`.

## Repo Layout
- `local-rag/src` - renderer UI (React)
- `local-rag/electron` - Electron main process, indexing, retrieval, vector store
- `local-rag/resources` - local models and runtime binaries

## More Documentation
- App setup and platform notes: [`local-rag/README.md`](local-rag/README.md)
- Focus mode technical notes: [`local-rag/TECHNICAL_NOTES_FOCUS_MODE.md`](local-rag/TECHNICAL_NOTES_FOCUS_MODE.md)
- Hackathon overview: [`local-rag/HACKATHON_TECH_OVERVIEW.txt`](local-rag/HACKATHON_TECH_OVERVIEW.txt)


<img width="806" height="537" alt="gallery" src="https://github.com/user-attachments/assets/aae8caf6-4514-4d5b-8f52-538bb97ffb90" />

this above is architecture 

<img width="1209" height="697" alt="Screenshot 2026-05-01 at 9 40 36 AM" src="https://github.com/user-attachments/assets/ed070acc-bda3-4a8c-bc73-0d78285cb910" />

this above i dont know ill tell u later for now keep it as working product screenshot s

<img width="806" height="513" alt="gallery-2" src="https://github.com/user-attachments/assets/a94f7e4c-bb29-4d18-8ab9-c25fe6a31e35" />

this is main logog maybe keeop it in the front of everytjing 

https://www.youtube.com/watch?v=r7eSFDm4Wd4
thaT IS OUR MAIN TYOUYURB VIDEO LINK 





## Recruiter Snapshot
- Built a local-first AI context system for project-aware development workflows.
- Implemented hybrid retrieval over mixed file types, including OCR-backed image support.
- Designed toward assistant handoff: retrieve once, send compact context, avoid repeated full-repo scans.
