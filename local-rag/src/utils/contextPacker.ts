import type { SearchResult } from "../types/global";

/**
 * Obi context packer.
 *
 * Pure function over `SearchResult[]` that produces a structured context bundle
 * suitable for:
 *  - the in-app RAG prefix sent to the local llama.cpp chat
 *  - clipboard / file export to external IDE agents (Cursor, Claude, etc.)
 *
 * Per-modality handling:
 *  - text / pdf / code: full path + section + clamped content body
 *  - image:             full path + filename + a hint that the agent should
 *                       open or attach the image file itself (we do NOT inline
 *                       OCR or captions in v1; that can be added later)
 */

export type PackerKind = "text" | "code" | "image";

export type ContextItem = {
    rank: number;
    chunkId: number;
    path: string;
    fileName: string;
    /** "image" if SearchResult.modality === "image"; otherwise "code" if extension looks code-like; else "text". */
    kind: PackerKind;
    sectionTitle: string;
    score: number;
    content: string;
};

export type ContextBundle = {
    query: string;
    generatedAtMs: number;
    items: ContextItem[];
    totals: {
        items: number;
        chars: number;
        estTokens: number;
    };
};

export type PackOptions = {
    query?: string;
    /** Per-item content character clamp. Default 600. */
    maxCharsPerItem?: number;
    /** Total markdown character budget across all items. Default 3500. */
    maxTotalChars?: number;
};

const DEFAULT_MAX_CHARS_PER_ITEM = 600;
const DEFAULT_MAX_TOTAL_CHARS = 3500;
const APPROX_CHARS_PER_TOKEN = 4;

const CODE_LIKE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".m", ".mm",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".cs", ".php", ".scala",
    ".html", ".htm", ".vue", ".svelte",
    ".css", ".scss", ".sass", ".less",
    ".sh", ".bash", ".zsh", ".ps1",
    ".graphql", ".gql", ".proto", ".tf", ".hcl",
]);

function getExtension(p: string): string {
    const idx = p.lastIndexOf(".");
    if (idx < 0) return "";
    return p.slice(idx).toLowerCase();
}

function deriveKind(result: SearchResult): PackerKind {
    if (result.modality === "image") return "image";
    return CODE_LIKE_EXTENSIONS.has(getExtension(result.documentPath)) ? "code" : "text";
}

function sanitize(text: string): string {
    if (!text) return "";
    return text
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function clamp(text: string, max: number): string {
    if (!text) return "";
    if (text.length <= max) return text;
    return text.slice(0, max).trimEnd() + "…";
}

function formatItemMarkdown(item: ContextItem): string {
    const header = `Source ${item.rank} (${item.kind}): ${item.fileName}`;
    const lines: string[] = [header, `Path: ${item.path}`];
    if (item.sectionTitle) lines.push(`Section: ${item.sectionTitle}`);
    if (item.kind === "image") {
        lines.push("Hint: Image file. Open or attach the file at the path above to view its contents.");
    } else {
        lines.push(`Content: ${item.content}`);
    }
    return lines.join("\n");
}

/**
 * Pack retrieved results into a structured bundle and a markdown representation.
 *
 * Budget enforcement:
 *  1. Each item's content is first clamped to `maxCharsPerItem`.
 *  2. The full markdown is then assembled; if it exceeds `maxTotalChars`,
 *     low-rank items are dropped from the tail until the budget fits.
 *  3. Image items contribute a small fixed-size hint (no body), so they are
 *     cheap and usually retained.
 */
export function packContext(
    results: SearchResult[],
    options: PackOptions = {}
): { bundle: ContextBundle; markdown: string } {
    const {
        query = "",
        maxCharsPerItem = DEFAULT_MAX_CHARS_PER_ITEM,
        maxTotalChars = DEFAULT_MAX_TOTAL_CHARS,
    } = options;

    const items: ContextItem[] = results.map((r, index) => {
        const kind = deriveKind(r);
        const rawContent = kind === "image" ? "" : sanitize(r.content ?? "");
        return {
            rank: index + 1,
            chunkId: r.chunkId,
            path: r.documentPath,
            fileName: r.fileName,
            kind,
            sectionTitle: r.sectionTitle ?? "",
            score: typeof r.distance === "number" ? r.distance : 0,
            content: clamp(rawContent, maxCharsPerItem),
        };
    });

    const sections = items.map(formatItemMarkdown);
    const separator = "\n\n---\n\n";

    let kept = sections.length;
    let assembled = sections.join(separator);
    while (kept > 0 && assembled.length > maxTotalChars) {
        kept -= 1;
        assembled = sections.slice(0, kept).join(separator);
    }

    const finalItems = items.slice(0, kept);
    const finalMarkdown = assembled;

    const bundle: ContextBundle = {
        query,
        generatedAtMs: Date.now(),
        items: finalItems,
        totals: {
            items: finalItems.length,
            chars: finalMarkdown.length,
            estTokens: Math.ceil(finalMarkdown.length / APPROX_CHARS_PER_TOKEN),
        },
    };

    return { bundle, markdown: finalMarkdown };
}

/**
 * Build the existing in-chat RAG prefix string from packed markdown so the
 * local llama.cpp chat behavior is unchanged.
 */
export function buildChatPromptPrefix(markdown: string): string {
    if (!markdown) return "";
    return (
        "Use the retrieved context below to answer the question. " +
        "Prefer this context when relevant; if image captions are included, treat them as visual evidence. " +
        "If OCR lines are included, treat them as text extracted from images. " +
        "Say plainly if context is insufficient.\n\n" +
        markdown +
        "\n\n---\n\nQuestion: "
    );
}

/**
 * Convenience export that mirrors today's `buildRagContextPrefix` behavior so
 * the renderer can swap to the packer with a single line change.
 */
export function packForChatPrefix(
    results: SearchResult[],
    options: PackOptions = {}
): string {
    if (!results.length) return "";
    const { markdown } = packContext(results, options);
    return buildChatPromptPrefix(markdown);
}
