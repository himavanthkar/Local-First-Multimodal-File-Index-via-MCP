import type { SqliteDatabase } from "./db.js";
import type { PackInputItem } from "./contextPacker.js";

/**
 * Lightweight retrieval for the standalone MCP server.
 *
 * Constraint: this process does NOT load the local llama embedding sidecar,
 * so we cannot generate query vectors here. We use:
 *   1. SQLite FTS5 over `chunks_fts` for lexical text/code/PDF search.
 *   2. Filename `LIKE` against `image_documents` for image hits.
 *
 * Semantic vector search remains available inside the Obi app itself (and is
 * the next step for a richer MCP server, either by reusing the embeddings via
 * an embedded HTTP endpoint or by loading the model in this process).
 */

type ChunkRow = {
    chunk_id: number;
    document_path: string;
    file_name: string;
    content: string;
    section_title: string | null;
    bm25_score: number;
};

type ImageRow = {
    image_id: number;
    document_path: string;
    file_name: string;
};

function buildFtsMatch(query: string): string {
    const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, "").trim())
        .filter(Boolean);
    if (!tokens.length) return '""';
    return tokens.map((t) => `"${t}"`).join(" OR ");
}

export function searchObiIndex(
    db: SqliteDatabase,
    query: string,
    limit: number
): PackInputItem[] {
    const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));

    const chunkRows = (() => {
        try {
            return db
                .prepare(
                    `SELECT
                        c.id          AS chunk_id,
                        d.path        AS document_path,
                        d.file_name   AS file_name,
                        c.content     AS content,
                        c.section_title AS section_title,
                        bm25(chunks_fts) AS bm25_score
                     FROM chunks_fts
                     JOIN chunks c    ON c.id   = chunks_fts.chunk_id
                     JOIN documents d ON d.path = chunks_fts.document_path
                     WHERE chunks_fts MATCH ?
                     ORDER BY bm25_score ASC
                     LIMIT ?`
                )
                .all(buildFtsMatch(query), safeLimit) as ChunkRow[];
        } catch {
            return [] as ChunkRow[];
        }
    })();

    const imageRows = (() => {
        try {
            const needle = `%${query.toLowerCase()}%`;
            return db
                .prepare(
                    `SELECT
                        i.id        AS image_id,
                        i.path      AS document_path,
                        i.file_name AS file_name
                     FROM image_documents i
                     WHERE lower(i.file_name) LIKE ?
                     ORDER BY i.indexed_at_ms DESC
                     LIMIT ?`
                )
                .all(needle, Math.max(1, Math.floor(safeLimit / 2))) as ImageRow[];
        } catch {
            return [] as ImageRow[];
        }
    })();

    const items: PackInputItem[] = [];
    const seenChunk = new Set<number>();

    for (const row of chunkRows) {
        if (seenChunk.has(row.chunk_id)) continue;
        seenChunk.add(row.chunk_id);
        items.push({
            chunkId: row.chunk_id,
            documentPath: row.document_path,
            fileName: row.file_name,
            content: row.content,
            sectionTitle: row.section_title ?? "",
            distance: row.bm25_score,
            modality: "text",
        });
    }

    for (const row of imageRows) {
        items.push({
            chunkId: row.image_id,
            documentPath: row.document_path,
            fileName: row.file_name,
            content: `[image] ${row.file_name}`,
            sectionTitle: "",
            distance: 0,
            modality: "image",
        });
    }

    return items.slice(0, safeLimit);
}
