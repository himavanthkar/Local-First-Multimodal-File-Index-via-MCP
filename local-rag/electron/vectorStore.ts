import fs from "node:fs"
import path from "node:path"
import { getDb } from "./database"
import { SearchResult } from "../src/types/global"
import {
    IndexedModality,
    IndexingOptions,
    IndexingRules,
    resolveFileModality,
    shouldChunkAsCode,
} from "./indexingRules"

type EmbedOneFn = (text: string) => Promise<number[]>
type EmbedManyFn = (texts: string[]) => Promise<number[][]>
type ImageEmbedFn = (imagePath: string) => Promise<number[]>
type ImageQueryEmbedFn = (queryText: string) => Promise<number[]>
type IndexingStats = {
    scanned: number
    indexed: number
    skipped: number
    textIndexed: number
    codeIndexed: number
    imageIndexed: number
    lastIndexedAtMs: number | null
}
type ChunkWithMeta = {
    content: string
    sectionTitle: string
    charStart: number
    charEnd: number
}
const MAX_SKIP_EVENTS = 50_000

export class VectorStore {
    private stats: IndexingStats = {
        scanned: 0,
        indexed: 0,
        skipped: 0,
        textIndexed: 0,
        codeIndexed: 0,
        imageIndexed: 0,
        lastIndexedAtMs: null,
    }

    constructor(
        private readonly embedOne: EmbedOneFn,
        private readonly embedMany: EmbedManyFn,
        private readonly embedImage: ImageEmbedFn,
        private readonly embedImageQuery: ImageQueryEmbedFn,
        private readonly embeddingDimensions: number,
        private readonly imageEmbeddingDimensions: number
    ) { }

    async indexDirectory(rootPath: string, options: IndexingOptions = {}) {
        // Reset per-run counters so "skipped/scanned" reflects the latest full scan.
        this.stats.scanned = 0
        this.stats.skipped = 0

        const rules = new IndexingRules(rootPath, options)
        const files = walkDirectory(rootPath, rules)
        let indexedCount = 0
        let skippedCount = 0

        for (const filePath of files) {
            const modality = rules.getFileModality(filePath)
            if (!modality) {
                skippedCount += 1
                this.recordSkipEvent(filePath, "unsupported_modality", null)
                continue
            }

            try {
                const result = await this.indexFile(filePath, modality)
                if (result.skipped) {
                    skippedCount += 1
                } else {
                    indexedCount += 1
                }
            } catch (error) {
                skippedCount += 1
                this.recordSkipEvent(filePath, "index_error", modality ?? null)
                console.error("[vectorStore] failed indexing file:", filePath, error)
            }
        }

        return { indexedCount, skippedCount }
    }

    async indexFile(filePath: string, modality?: IndexedModality) {
        this.stats.scanned += 1
        const indexedModality =
            modality ??
            resolveFileModality(filePath, { includeCodeFiles: true, indexAllFiles: false })
        if (!indexedModality) {
            this.recordSkipEvent(filePath, "unsupported_modality", null)
            return { skipped: true as const, reason: "unsupported_modality" as const }
        }
        if (indexedModality === "image") {
            return this.indexImage(filePath)
        }

        return this.indexTextFile(filePath, indexedModality)
    }

    private async indexTextFile(filePath: string, modality: IndexedModality = "text") {
        const db = getDb()
        const extension = path.extname(filePath).toLowerCase()

        const stat = fs.statSync(filePath)
        const updatedAtMs = Math.trunc(stat.mtimeMs)

        const existingDoc = db
            .prepare("SELECT id, updated_at_ms FROM documents WHERE path = ?")
            .get(filePath) as { id: number; updated_at_ms: number } | undefined

        if (existingDoc && existingDoc.updated_at_ms === updatedAtMs) {
            this.recordSkipEvent(filePath, "unchanged", modality)
            return { skipped: true as const, reason: "unchanged" as const }
        }

        const rawText = await safeReadTextFile(filePath)
        const textToIndex = extension === ".pdf" ? buildPdfIndexText(filePath, rawText) : rawText
        if (!textToIndex.trim()) {
            this.recordSkipEvent(filePath, "empty", modality)
            return { skipped: true as const, reason: "empty" as const }
        }

        const chunks = chunkTextWithMetadata(filePath, textToIndex, 800, 120)
        if (chunks.length === 0) {
            this.recordSkipEvent(filePath, "no_chunks", modality)
            return { skipped: true as const, reason: "no_chunks" as const }
        }

        const embeddings = await this.embedMany(chunks.map((chunk) => chunk.content))

        for (const embedding of embeddings) {
            if (embedding.length !== this.embeddingDimensions) {
                throw new Error(
                    `Embedding dimension mismatch. Expected ${this.embeddingDimensions}, got ${embedding.length}`
                )
            }
        }

        let documentId!: number

        const tx = db.transaction(() => {
            if (existingDoc) {
                documentId = existingDoc.id

                db.prepare(`
          DELETE FROM chunk_embeddings
          WHERE chunk_id IN (
            SELECT id FROM chunks WHERE document_id = ?
          )
        `).run(documentId)
                db.prepare(`
          DELETE FROM chunks_fts
          WHERE chunk_id IN (
            SELECT id FROM chunks WHERE document_id = ?
          )
        `).run(documentId)

                db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId)

                db.prepare(`
          UPDATE documents
          SET file_name = ?, updated_at_ms = ?, indexed_at_ms = ?, index_count = COALESCE(index_count, 1) + 1
          WHERE id = ?
        `).run(path.basename(filePath), updatedAtMs, Date.now(), documentId)
            } else {
                const result = db.prepare(`
          INSERT INTO documents (path, file_name, updated_at_ms, indexed_at_ms, index_count)
          VALUES (?, ?, ?, ?, 1)
        `).run(filePath, path.basename(filePath), updatedAtMs, Date.now())

                documentId = Number(result.lastInsertRowid)
            }

            const insertChunk = db.prepare(
                `INSERT INTO chunks (document_id, chunk_index, content, section_title, char_start, char_end)
                VALUES (?, ?, ?, ?, ?, ?)`
            )

            const insertEmbedding = db.prepare(
                `INSERT INTO chunk_embeddings (chunk_id, embedding)
                VALUES (CAST(? AS INTEGER), vec_f32(?))`
            )
            const insertLexical = db.prepare(
                `INSERT INTO chunks_fts (content, chunk_id, document_path)
                VALUES (?, ?, ?)`
            )

            for (let i = 0; i < chunks.length; i += 1) {
                const chunk = chunks[i]
                const chunkResult = insertChunk.run(
                    documentId!,
                    i,
                    chunk.content,
                    chunk.sectionTitle,
                    chunk.charStart,
                    chunk.charEnd
                )
                const chunkId = chunkResult.lastInsertRowid

                // Guard against stale/orphan vec rows from prior resets.
                db.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = CAST(? AS INTEGER)").run(chunkId)
                insertEmbedding.run(chunkId, serializeVector(embeddings[i]))
                insertLexical.run(chunk.content, chunkId, filePath)
            }
        })

        tx()

        this.recordIndexed(modality === "code" ? "code" : "text")
        return {
            skipped: false as const,
            chunkCount: chunks.length,
        }
    }

    private async indexImage(filePath: string) {
        const db = getDb()
        const stat = fs.statSync(filePath)
        const updatedAtMs = Math.trunc(stat.mtimeMs)

        const existingImage = db
            .prepare("SELECT id, updated_at_ms FROM image_documents WHERE path = ?")
            .get(filePath) as { id: number; updated_at_ms: number } | undefined

        if (existingImage && existingImage.updated_at_ms === updatedAtMs) {
            this.recordSkipEvent(filePath, "unchanged", "image")
            return { skipped: true as const, reason: "unchanged" as const }
        }

        let embedding: number[]
        try {
            embedding = await this.embedImage(filePath)
        } catch (error) {
            this.recordSkipEvent(filePath, "image_embedding_failed", "image")
            console.error("[vectorStore] image embedding failed; skipping image:", filePath, error)
            return { skipped: true as const, reason: "image_embedding_failed" as const }
        }
        if (embedding.length !== this.imageEmbeddingDimensions) {
            throw new Error(
                `Image embedding dimension mismatch. Expected ${this.imageEmbeddingDimensions}, got ${embedding.length}`
            )
        }
        console.log(
            "[vectorStore] image embedding produced:",
            filePath,
            `dim=${embedding.length}`
        )

        let imageId!: number
        const tx = db.transaction(() => {
            if (existingImage) {
                imageId = existingImage.id
                db.prepare("DELETE FROM image_embeddings_clip WHERE image_id = ?").run(imageId)
                db.prepare(`
                    UPDATE image_documents
                    SET file_name = ?, updated_at_ms = ?, indexed_at_ms = ?, index_count = COALESCE(index_count, 1) + 1
                    WHERE id = ?
                `).run(path.basename(filePath), updatedAtMs, Date.now(), imageId)
            } else {
                const insertResult = db.prepare(`
                    INSERT INTO image_documents (path, file_name, updated_at_ms, indexed_at_ms, width, height, index_count)
                    VALUES (?, ?, ?, ?, NULL, NULL, 1)
                `).run(filePath, path.basename(filePath), updatedAtMs, Date.now())
                imageId = Number(insertResult.lastInsertRowid)
            }

            db.prepare("DELETE FROM image_embeddings_clip WHERE image_id = CAST(? AS INTEGER)").run(imageId)
            db.prepare(`
                INSERT INTO image_embeddings_clip (image_id, embedding)
                VALUES (CAST(? AS INTEGER), vec_f32(?))
            `).run(imageId, serializeVector(embedding))
        })

        tx()
        this.recordIndexed("image")
        return { skipped: false as const, modality: "image" as const }
    }

    async search(query: string, limit = 5): Promise<SearchResult[]> {
        const db = getDb()
        const queryEmbedding = await this.embedOne(query)
        let imageQueryEmbedding: number[] | null = null
        try {
            imageQueryEmbedding = await this.embedImageQuery(query)
            console.log(
                "[vectorStore] image query embedding ok:",
                `dim=${imageQueryEmbedding?.length ?? 0}`
            )
        } catch (error) {
            console.warn("[vectorStore] image query embedding failed; using text-only fallback", error)
        }

        if (queryEmbedding.length !== this.embeddingDimensions) {
            throw new Error(
                `Embedding dimension mismatch. Expected ${this.embeddingDimensions}, got ${queryEmbedding.length}`
            )
        }
        if (imageQueryEmbedding && imageQueryEmbedding.length !== this.imageEmbeddingDimensions) {
            throw new Error(
                `Image query embedding dimension mismatch. Expected ${this.imageEmbeddingDimensions}, got ${imageQueryEmbedding.length}`
            )
        }

        const textSemanticRows = db.prepare(
            `SELECT
                c.id AS chunk_id,
                d.path AS document_path,
                d.file_name AS file_name,
                c.content AS content,
                c.section_title AS section_title,
                distance
            FROM chunk_embeddings
            JOIN chunks c ON c.id = chunk_embeddings.chunk_id
            JOIN documents d ON d.id = c.document_id
            WHERE embedding MATCH ?
                AND k = ?
            ORDER BY distance ASC`
        ).all(serializeVector(queryEmbedding), limit) as Array<{
            chunk_id: number
            document_path: string
            file_name: string
            content: string
            section_title: string
            distance: number
        }>

        const textLexicalRows = db.prepare(
            `SELECT
                c.id AS chunk_id,
                d.path AS document_path,
                d.file_name AS file_name,
                c.content AS content,
                c.section_title AS section_title,
                bm25(chunks_fts) AS bm25_score
            FROM chunks_fts
            JOIN chunks c ON c.id = chunks_fts.chunk_id
            JOIN documents d ON d.path = chunks_fts.document_path
            WHERE chunks_fts MATCH ?
            ORDER BY bm25_score ASC
            LIMIT ?`
        ).all(buildFtsQuery(query), limit) as Array<{
            chunk_id: number
            document_path: string
            file_name: string
            content: string
            section_title: string
            bm25_score: number
        }>

        let imageRows: Array<{
            image_id: number
            document_path: string
            file_name: string
            distance: number
        }> = []
        if (imageQueryEmbedding) {
            imageRows = db.prepare(
                `SELECT
                    i.id AS image_id,
                    i.path AS document_path,
                    i.file_name AS file_name,
                    distance
                FROM image_embeddings_clip
                JOIN image_documents i ON i.id = image_embeddings_clip.image_id
                WHERE embedding MATCH ?
                    AND k = ?
                ORDER BY distance ASC`
            ).all(serializeVector(imageQueryEmbedding), limit) as Array<{
                image_id: number
                document_path: string
                file_name: string
                distance: number
            }>
        }
        const filenameImageRows = findImageRowsByFilenameQuery(db, query, limit)
        if (filenameImageRows.length) {
            imageRows = [...imageRows, ...filenameImageRows]
        }

        const merged = mergeRankedResults(query, textSemanticRows, textLexicalRows, imageRows)

        return merged.slice(0, limit).map((row) => ({
            chunkId: row.chunkId,
            documentPath: row.documentPath,
            fileName: row.fileName,
            content: row.content,
            distance: row.distance,
            modality: row.modality,
            sectionTitle: row.sectionTitle,
        }))
    }

    async deleteDocument(filePath: string) {
        const db = getDb()

        const row = db
            .prepare("SELECT id FROM documents WHERE path = ?")
            .get(filePath) as { id: number } | undefined

        if (row) {
            const tx = db.transaction(() => {
                db.prepare(`DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)`).run(row.id);
                db.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)`).run(row.id);
                db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(row.id);
                db.prepare(`DELETE FROM documents WHERE id = ?`).run(row.id);
            });
            tx();
        }

        const imageRow = db
            .prepare("SELECT id FROM image_documents WHERE path = ?")
            .get(filePath) as { id: number } | undefined
        if (imageRow) {
            const imageTx = db.transaction(() => {
                db.prepare(`DELETE FROM image_embeddings_clip WHERE image_id = ?`).run(imageRow.id);
                db.prepare(`DELETE FROM image_documents WHERE id = ?`).run(imageRow.id);
            });
            imageTx();
        }

        return { deleted: Boolean(row || imageRow) }
    }

    async clearIndex() {
        const db = getDb()
        const tx = db.transaction(() => {
            db.prepare("DELETE FROM chunk_embeddings").run()
            db.prepare("DELETE FROM chunks_fts").run()
            db.prepare("DELETE FROM chunks").run()
            db.prepare("DELETE FROM documents").run()
            db.prepare("DELETE FROM image_embeddings_clip").run()
            db.prepare("DELETE FROM image_documents").run()
        })
        tx()

        this.stats.scanned = 0
        this.stats.skipped = 0
        this.stats.lastIndexedAtMs = Date.now()
        return { ok: true as const }
    }

    async getImageEmbeddingStatus() {
        const db = getDb()

        const imageDocCount = (db
            .prepare("SELECT COUNT(*) AS count FROM image_documents")
            .get() as { count: number } | undefined)?.count ?? 0

        const imageEmbeddingCount = (db
            .prepare("SELECT COUNT(*) AS count FROM image_embeddings_clip")
            .get() as { count: number } | undefined)?.count ?? 0

        const sampleRow = db
            .prepare(`
                SELECT i.path AS path, i.file_name AS file_name
                FROM image_documents i
                JOIN image_embeddings_clip e ON e.image_id = i.id
                LIMIT 1
            `)
            .get() as { path: string; file_name: string } | undefined

        let queryEmbeddingDim: number | null = null
        let queryEmbeddingError: string | null = null
        try {
            const vec = await this.embedImageQuery("a photo for diagnostic test")
            queryEmbeddingDim = vec.length
        } catch (error) {
            queryEmbeddingError = error instanceof Error ? error.message : String(error)
        }

        const status = {
            imageDocCount,
            imageEmbeddingCount,
            expectedDimensions: this.imageEmbeddingDimensions,
            queryEmbeddingDim,
            queryEmbeddingError,
            sampleImage: sampleRow ?? null,
            isWorking:
                imageEmbeddingCount > 0 &&
                queryEmbeddingDim === this.imageEmbeddingDimensions &&
                queryEmbeddingError === null,
        }

        console.log("[vectorStore] image embedding status:", status)
        return status
    }

    getStats() {
        const db = getDb()

        const textAndCodeRows = db
            .prepare("SELECT path FROM documents")
            .all() as Array<{ path: string }>
        const imageRows = db
            .prepare("SELECT COUNT(*) AS count FROM image_documents")
            .get() as { count: number }

        let textIndexed = 0
        let codeIndexed = 0
        for (const row of textAndCodeRows) {
            const modality = resolveFileModality(row.path, {
                includeCodeFiles: true,
                indexAllFiles: false,
            })
            if (modality === "code") {
                codeIndexed += 1
            } else {
                textIndexed += 1
            }
        }

        const imageIndexed = Number(imageRows?.count ?? 0)
        const indexed = textIndexed + codeIndexed + imageIndexed

        return {
            ...this.stats,
            indexed,
            textIndexed,
            codeIndexed,
            imageIndexed,
        }
    }

    getRecentIndexedFiles(limit = 12) {
        const db = getDb()
        const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
        const rows = db.prepare(`
            SELECT
                path,
                file_name,
                indexed_at_ms,
                updated_at_ms,
                index_count,
                kind
            FROM (
                SELECT
                    d.path AS path,
                    d.file_name AS file_name,
                    d.indexed_at_ms AS indexed_at_ms,
                    d.updated_at_ms AS updated_at_ms,
                    COALESCE(d.index_count, 1) AS index_count,
                    'doc' AS kind
                FROM documents d
                UNION ALL
                SELECT
                    i.path AS path,
                    i.file_name AS file_name,
                    i.indexed_at_ms AS indexed_at_ms,
                    i.updated_at_ms AS updated_at_ms,
                    COALESCE(i.index_count, 1) AS index_count,
                    'image' AS kind
                FROM image_documents i
            )
            ORDER BY indexed_at_ms DESC
            LIMIT ?
        `).all(safeLimit) as Array<{
            path: string
            file_name: string
            indexed_at_ms: number
            updated_at_ms: number
            index_count: number
            kind: "doc" | "image"
        }>

        return rows.map((row) => {
            const modality =
                row.kind === "image"
                    ? ("image" as const)
                    : resolveFileModality(row.path, {
                          includeCodeFiles: true,
                          indexAllFiles: false,
                      }) ?? ("text" as const)
            return {
                path: row.path,
                fileName: row.file_name,
                indexedAtMs: Number(row.indexed_at_ms ?? 0),
                updatedAtMs: Number(row.updated_at_ms ?? 0),
                indexCount: Number(row.index_count ?? 1),
                modality: modality === "image" ? "image" : modality === "code" ? "code" : "text",
            }
        })
    }

    getRecentSkipEvents(limit = 100) {
        const db = getDb()
        const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
        const rows = db.prepare(`
            SELECT path, file_name, reason, modality, skipped_at_ms
            FROM index_skip_events
            ORDER BY skipped_at_ms DESC
            LIMIT ?
        `).all(safeLimit) as Array<{
            path: string
            file_name: string
            reason: string
            modality: string | null
            skipped_at_ms: number
        }>
        return rows.map((row) => ({
            path: row.path,
            fileName: row.file_name,
            reason: row.reason,
            modality: row.modality as "text" | "code" | "image" | null,
            skippedAtMs: Number(row.skipped_at_ms ?? 0),
        }))
    }

    private recordIndexed(modality: IndexedModality) {
        this.stats.lastIndexedAtMs = Date.now()
        // Totals are derived from the DB in getStats() to avoid drift.
        void modality
    }

    private recordSkipEvent(filePath: string, reason: string, modality: IndexedModality | null) {
        this.stats.skipped += 1
        try {
            const db = getDb()
            const now = Date.now()
            db.prepare(`
                INSERT INTO index_skip_events (path, file_name, reason, modality, skipped_at_ms)
                VALUES (?, ?, ?, ?, ?)
            `).run(filePath, path.basename(filePath), reason, modality, now)
            db.prepare(`
                DELETE FROM index_skip_events
                WHERE id NOT IN (
                    SELECT id
                    FROM index_skip_events
                    ORDER BY skipped_at_ms DESC, id DESC
                    LIMIT ?
                )
            `).run(MAX_SKIP_EVENTS)
        } catch (error) {
            console.warn("[vectorStore] failed to record skip event:", filePath, reason, error)
        }
    }
}


// Helpers
function walkDirectory(rootPath: string, rules: IndexingRules): string[] {
    const results: string[] = []

    function walk(currentPath: string) {
        if (rules.shouldSkipDirectory(currentPath)) return
        const entries = fs.readdirSync(currentPath, { withFileTypes: true })

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name)

            if (entry.isDirectory()) {
                walk(fullPath)
            } else if (entry.isFile()) {
                if (rules.shouldSkipFile(fullPath)) continue
                results.push(fullPath)
            }
        }
    }

    walk(rootPath)
    return results
}

async function safeReadTextFile(filePath: string) {
    const extension = path.extname(filePath).toLowerCase()
    if (extension === ".pdf") {
        try {
            const pdfParseModule = await import("pdf-parse")
            const PDFParse = (pdfParseModule as { PDFParse?: new (options: { data: Buffer }) => { getText: () => Promise<{ text?: string }>; destroy?: () => Promise<void> } }).PDFParse
            if (!PDFParse) {
                throw new Error("PDFParse class not found in pdf-parse module")
            }
            const data = fs.readFileSync(filePath)
            const parser = new PDFParse({ data })
            try {
                const parsed = await parser.getText()
                return parsed?.text ?? ""
            } finally {
                await parser.destroy?.().catch(() => { })
            }
        } catch (error) {
            console.warn("[vectorStore] failed to extract PDF text; skipping:", filePath, error)
            return ""
        }
    }
    if (extension === ".xlsx" || extension === ".xls") {
        try {
            const xlsxModule = await import("xlsx")
            const XLSX = (xlsxModule as {
                readFile: (path: string, opts?: Record<string, unknown>) => {
                    SheetNames: string[]
                    Sheets: Record<string, unknown>
                }
                utils: { sheet_to_csv: (sheet: unknown, opts?: Record<string, unknown>) => string }
            })
            const workbook = XLSX.readFile(filePath, { cellDates: true })
            const parts: string[] = []
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName]
                if (!sheet) continue
                const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim()
                if (!csv) continue
                parts.push(`Sheet: ${sheetName}\n${csv}`)
            }
            return parts.join("\n\n")
        } catch (error) {
            console.warn("[vectorStore] failed to extract spreadsheet text; skipping:", filePath, error)
            return ""
        }
    }
    return fs.readFileSync(filePath, "utf8")
}

/** Shown in the index when pdf-parse finds no text layer (scanned / image-only PDFs). */
const PDF_NO_EXTRACTABLE_TEXT_FOOTER =
    "\n\n[Obi PDF note: No selectable text was extracted from this file. " +
    "Many tax and government PDFs are scanned images, so the index only has the filename and this message until you OCR or export text and re-index.]"

const PDF_MIN_USEFUL_TEXT_CHARS = 32

function buildPdfIndexText(filePath: string, extractedText: string): string {
    const fileName = path.basename(filePath)
    const stem = fileName.replace(/\.pdf$/i, "")
    const stemTerms = stem
        .replace(/[_-]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim()

    const metadataLine = `PDF file ${fileName}${stemTerms ? ` title ${stemTerms}` : ""}`
    const body = extractedText.trim()

    // Keep lightweight metadata so scanned/image-only PDFs remain searchable by name/type.
    if (!body) return `${metadataLine}${PDF_NO_EXTRACTABLE_TEXT_FOOTER}`
    if (body.length < PDF_MIN_USEFUL_TEXT_CHARS) {
        return `${metadataLine}\n\n${body}${PDF_NO_EXTRACTABLE_TEXT_FOOTER}`
    }
    if (body.toLowerCase().includes("pdf")) return `${metadataLine}\n\n${body}`
    return `${metadataLine}\n\npdf\n\n${body}`
}

function chunkText(text: string, chunkSize = 800, overlap = 120): ChunkWithMeta[] {
    const normalized = text.replace(/\r\n/g, "\n").trim()
    if (!normalized) return []

    const chunks: ChunkWithMeta[] = []
    let start = 0

    while (start < normalized.length) {
        const end = Math.min(start + chunkSize, normalized.length)
        const chunk = normalized.slice(start, end).trim()

        if (chunk) {
            chunks.push({
                content: chunk,
                sectionTitle: "",
                charStart: start,
                charEnd: end,
            })
        }
        if (end === normalized.length) break

        start = Math.max(end - overlap, start + 1)
    }

    return chunks
}

function serializeVector(vector: number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer)
}

function chunkTextWithMetadata(filePath: string, text: string, chunkSize: number, overlap: number): ChunkWithMeta[] {
    const extension = path.extname(filePath).toLowerCase()
    if (extension === ".md" || extension === ".mdx") {
        return chunkMarkdownText(text, chunkSize, overlap)
    }
    if (shouldChunkAsCode(filePath)) {
        return chunkCodeText(text, chunkSize, overlap)
    }
    return chunkText(text, chunkSize, overlap)
}

function chunkMarkdownText(text: string, chunkSize: number, overlap: number): ChunkWithMeta[] {
    const normalized = text.replace(/\r\n/g, "\n").trim()
    if (!normalized) return []

    const headerRegex = /^(#{1,6})\s+(.+)$/gm
    const sections: Array<{ title: string; start: number; end: number }> = []
    let match: RegExpExecArray | null
    while ((match = headerRegex.exec(normalized)) !== null) {
        sections.push({
            title: match[2].trim(),
            start: match.index,
            end: normalized.length,
        })
    }

    for (let i = 0; i < sections.length; i += 1) {
        const next = sections[i + 1]
        sections[i].end = next ? next.start : normalized.length
    }

    if (sections.length === 0) {
        return chunkText(normalized, chunkSize, overlap)
    }

    const chunks: ChunkWithMeta[] = []
    for (const section of sections) {
        const sectionText = normalized.slice(section.start, section.end).trim()
        if (!sectionText) continue
        const sectionChunks = chunkText(sectionText, chunkSize, overlap).map((chunk) => ({
            ...chunk,
            sectionTitle: section.title,
            charStart: chunk.charStart + section.start,
            charEnd: chunk.charEnd + section.start,
        }))
        chunks.push(...sectionChunks)
    }
    return chunks
}

function chunkCodeText(text: string, chunkSize: number, overlap: number): ChunkWithMeta[] {
    const normalized = text.replace(/\r\n/g, "\n")
    if (!normalized.trim()) return []

    const boundaryRegex = /^(?:\s*(?:export\s+)?(?:async\s+)?function\s+\w+|\s*(?:export\s+)?class\s+\w+|\s*def\s+\w+\s*\(|\s*(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(|\s*interface\s+\w+)/gm
    const boundaries: number[] = [0]
    let match: RegExpExecArray | null
    while ((match = boundaryRegex.exec(normalized)) !== null) {
        if (!boundaries.includes(match.index)) {
            boundaries.push(match.index)
        }
    }
    boundaries.push(normalized.length)
    boundaries.sort((a, b) => a - b)

    const chunks: ChunkWithMeta[] = []
    for (let i = 0; i < boundaries.length - 1; i += 1) {
        const start = boundaries[i]
        const end = boundaries[i + 1]
        const block = normalized.slice(start, end).trim()
        if (!block) continue

        if (block.length <= chunkSize) {
            const firstLine = block.split("\n")[0]?.trim() ?? "code-block"
            chunks.push({
                content: block,
                sectionTitle: firstLine.slice(0, 120),
                charStart: start,
                charEnd: end,
            })
            continue
        }

        const fallbackChunks = chunkText(block, chunkSize, overlap).map((chunk) => ({
            ...chunk,
            sectionTitle: block.split("\n")[0]?.trim().slice(0, 120) ?? "code-block",
            charStart: chunk.charStart + start,
            charEnd: chunk.charEnd + start,
        }))
        chunks.push(...fallbackChunks)
    }

    return chunks
}

type RankedResult = {
    chunkId: number
    documentPath: string
    fileName: string
    content: string
    modality: "text" | "image"
    sectionTitle: string
    score: number
    distance: number
}

function buildFtsQuery(query: string): string {
    const tokens = query
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.replace(/[^\p{L}\p{N}_-]/gu, "").trim())
        .filter(Boolean)

    if (tokens.length === 0) return "\"\""
    return tokens.map((token) => `"${token}"`).join(" OR ")
}

function mergeRankedResults(
    query: string,
    textSemanticRows: Array<{
        chunk_id: number
        document_path: string
        file_name: string
        content: string
        section_title: string
        distance: number
    }>,
    textLexicalRows: Array<{
        chunk_id: number
        document_path: string
        file_name: string
        content: string
        section_title: string
        bm25_score: number
    }>,
    imageRows: Array<{
        image_id: number
        document_path: string
        file_name: string
        distance: number
    }>
): RankedResult[] {
    const rrfK = 60
    const visualQuery = isLikelyVisualQuery(query)
    const textSemanticWeight = visualQuery ? 0.45 : 0.55
    const textLexicalWeight = visualQuery ? 0.2 : 0.3
    const imageWeight = visualQuery ? 0.8 : 0.45
    const scoreMap = new Map<string, RankedResult>()

    const upsertScore = (
        key: string,
        base: Omit<RankedResult, "score" | "distance">,
        rank: number,
        weight: number
    ) => {
        const existing = scoreMap.get(key)
        const increment = weight / (rrfK + rank)
        if (!existing) {
            scoreMap.set(key, {
                ...base,
                score: increment,
                distance: Number.POSITIVE_INFINITY,
            })
            return
        }
        existing.score += increment
    }

    textSemanticRows.forEach((row, index) => {
        const key = `text:${row.chunk_id}`
        upsertScore(
            key,
            {
                chunkId: row.chunk_id,
                documentPath: row.document_path,
                fileName: row.file_name,
                content: row.content,
                modality: "text",
                sectionTitle: row.section_title ?? "",
            },
            index + 1,
            textSemanticWeight
        )
    })

    textLexicalRows.forEach((row, index) => {
        const key = `text:${row.chunk_id}`
        upsertScore(
            key,
            {
                chunkId: row.chunk_id,
                documentPath: row.document_path,
                fileName: row.file_name,
                content: row.content,
                modality: "text",
                sectionTitle: row.section_title ?? "",
            },
            index + 1,
            textLexicalWeight
        )
    })

    imageRows.forEach((row, index) => {
        const key = `image:${row.image_id}`
        upsertScore(
            key,
            {
                chunkId: row.image_id,
                documentPath: row.document_path,
                fileName: row.file_name,
                content: `[image] ${row.file_name}`,
                modality: "image",
                sectionTitle: "",
            },
            index + 1,
            imageWeight
        )
    })

    const merged = Array.from(scoreMap.values())
        .sort((a, b) => b.score - a.score)
        .map((result) => ({
            ...result,
            distance: 1 / (result.score + 1e-9),
        }))

    return merged
}

function isLikelyVisualQuery(query: string): boolean {
    const normalized = query.toLowerCase()
    return [
        "image",
        "photo",
        "picture",
        "screenshot",
        "diagram",
        "graph",
        "figure",
        "logo",
        "icon",
        "show",
        "see",
        "looks like",
        "what is in",
        "what's in",
        "in the image",
        "text in",
        "read this",
        "ocr",
    ].some((token) => normalized.includes(token))
}

function findImageRowsByFilenameQuery(
    db: ReturnType<typeof getDb>,
    query: string,
    limit: number
): Array<{
    image_id: number
    document_path: string
    file_name: string
    distance: number
}> {
    if (!looksLikeImageFilenameQuery(query)) return []

    const needles = query
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.replace(/^[.]+/, "").replace(/[^a-z0-9._-]/g, "").trim())
        .filter((token) => token.length >= 2)

    if (!needles.length) return []

    const rows = db.prepare(`
        SELECT
            i.id AS image_id,
            i.path AS document_path,
            i.file_name AS file_name
        FROM image_documents i
        ORDER BY i.indexed_at_ms DESC
        LIMIT 250
    `).all() as Array<{
        image_id: number
        document_path: string
        file_name: string
    }>

    const scored = rows
        .map((row) => {
            const haystack = `${row.file_name} ${row.document_path}`.toLowerCase()
            const score = needles.reduce((acc, needle) => acc + (haystack.includes(needle) ? 1 : 0), 0)
            if (score === 0) return null
            return {
                ...row,
                // Lower is better in existing ranking; map higher filename match score to smaller distance.
                distance: 1 / (score + 1),
                score,
            }
        })
        .filter((item): item is {
            image_id: number
            document_path: string
            file_name: string
            distance: number
            score: number
        } => Boolean(item))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

    return scored.map(({ image_id, document_path, file_name, distance }) => ({
        image_id,
        document_path,
        file_name,
        distance,
    }))
}

function looksLikeImageFilenameQuery(query: string): boolean {
    const normalized = query.toLowerCase().trim()
    if (!normalized) return false
    return (
        normalized.includes(".") ||
        ["png", "jpg", "jpeg", "gif", "webp", "image", "screenshot", "photo"].some((token) =>
            normalized.includes(token)
        )
    )
}

