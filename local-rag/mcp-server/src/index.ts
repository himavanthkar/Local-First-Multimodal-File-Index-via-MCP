#!/usr/bin/env node
/**
 * Obi MCP server (stdio transport).
 *
 * Exposes Obi's local SQLite-backed file/code/PDF/image index to MCP clients
 * such as Cursor. Pull-based: the IDE agent decides when to call the tool.
 *
 * Tools:
 *   - obi_search(query, limit?)  -> packed Markdown context (text/code/PDF
 *                                    chunks + image paths) ready to drop into
 *                                    the agent's context window.
 *
 * v1 limitations (documented in README.md):
 *   - No semantic vector search; lexical FTS5 + filename match only.
 *   - Read-only access to Obi's app.db.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { openObiDb, resolveObiDbPath } from "./db.js";
import { searchObiIndex } from "./search.js";
import { packContext } from "./contextPacker.js";

const server = new McpServer({
    name: "obi-mcp-server",
    version: "0.1.0",
});

server.tool(
    "obi_search",
    "Search Obi's local index (text, code, PDFs, images by filename) and return a compact Markdown context bundle. Use this before answering project questions to avoid re-reading the whole repo.",
    {
        query: z.string().describe("Natural-language or keyword query."),
        limit: z
            .number()
            .int()
            .min(1)
            .max(25)
            .optional()
            .describe("Max number of items in the bundle (default 8)."),
        maxCharsPerItem: z
            .number()
            .int()
            .min(100)
            .max(4000)
            .optional()
            .describe("Per-item content character clamp (default 1200)."),
        maxTotalChars: z
            .number()
            .int()
            .min(500)
            .max(40000)
            .optional()
            .describe("Total Markdown character budget (default 12000)."),
    },
    async ({ query, limit, maxCharsPerItem, maxTotalChars }) => {
        const db = openObiDb();
        try {
            const items = searchObiIndex(db, query, limit ?? 8);
            const { bundle, markdown } = packContext(items, {
                query,
                maxCharsPerItem,
                maxTotalChars,
            });

            const header =
                items.length === 0
                    ? `No matches for "${query}" in Obi's index.\n\n` +
                      "Tip: ensure Obi has indexed the relevant folder, or refine the query."
                    : `Obi context for: ${query}\n` +
                      `Items: ${bundle.totals.items} · ` +
                      `~${bundle.totals.estTokens} tokens · ` +
                      `${bundle.totals.chars} chars\n\n${markdown}`;

            return {
                content: [{ type: "text", text: header }],
            };
        } finally {
            db.close();
        }
    }
);

async function main() {
    // stdout is reserved for JSON-RPC; all logs MUST go to stderr.
    const dbPath = resolveObiDbPath();
    console.error(`[obi-mcp-server] using DB at ${dbPath}`);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[obi-mcp-server] ready on stdio");
}

main().catch((err) => {
    console.error("[obi-mcp-server] fatal:", err);
    process.exit(1);
});
