# Obi MCP Server (stdio)

A standalone Model Context Protocol (MCP) server that exposes Obi's local SQLite-backed file/code/PDF/image index to MCP clients such as **Cursor** and **Claude Desktop**. Pull-based: the IDE agent decides when to call the tool — there is no Obi UI button that "sends" anything.

## What it does today (v1)

- Tool: `obi_search(query, limit?, maxCharsPerItem?, maxTotalChars?)`
- Searches the same `app.db` Obi writes to, using:
  - **FTS5** lexical search over `chunks_fts` (text, code, PDF text)
  - Filename `LIKE` against `image_documents` for image hits
- Returns a **packed Markdown context bundle** with `Source N (kind): file / Path / Section / Content`. Image items include the absolute path so the agent can attach the file itself.
- Read-only access to Obi's database.

## What it does NOT do yet

- No semantic vector search (the local llama embedding sidecar is owned by the Obi app process). Lexical only for now.
- No write-back, no file edits.
- No HTTP/SSE transport — stdio only. An embedded HTTP/SSE variant is on the roadmap (see main README).

## Build

From `local-rag/mcp-server`:

```bash
npm install
npm run build
```

Output is `dist/index.js` with a `node` shebang.

## Wire it into Cursor

Edit `~/.cursor/mcp.json` (create if missing):

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

Restart Cursor. The agent will see a tool named `obi_search` and call it on its own when it judges it useful. You do not push from Obi; Cursor pulls.

To override the database location (e.g. running against a portable copy):

```json
{
  "mcpServers": {
    "obi": {
      "command": "node",
      "args": ["/abs/path/to/local-rag/mcp-server/dist/index.js"],
      "env": {
        "OBI_DB_PATH": "/abs/path/to/app.db"
      }
    }
  }
}
```

DB path resolution (when `OBI_DB_PATH` is unset):

1. macOS: `~/Library/Application Support/Obi/rag/app.db`, falls back to the dev `Electron` directory.
2. Windows: `%APPDATA%/Obi/rag/app.db`, then `Electron`.
3. Linux: `$XDG_CONFIG_HOME/Obi/rag/app.db`, then `Electron`.

## Wire it into Claude Desktop

Same idea — `claude_desktop_config.json` uses the same `mcpServers` shape. Restart Claude Desktop after editing.

## Smoke test from a shell

```bash
( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}'
  sleep 0.3
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 0.2
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"obi_search","arguments":{"query":"YOUR QUERY","limit":5}}}'
  sleep 1
) | node dist/index.js
```

You should see an MCP `result` containing `Source N (kind): ...` blocks.

## Notes

- This server can run **with Obi closed**. Indexing still happens inside the Obi app; the MCP server only reads.
- Logs are written to **stderr** only — `stdout` is reserved for JSON-RPC.
- Keep `local-rag/src/utils/contextPacker.ts` and `local-rag/mcp-server/src/contextPacker.ts` in sync; same shape on both sides.
