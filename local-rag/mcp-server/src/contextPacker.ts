/**
 * Standalone copy of the renderer's contextPacker, kept self-contained so the
 * MCP server has no React / Electron dependencies.
 *
 * Keep this in sync with `local-rag/src/utils/contextPacker.ts`.
 */

export type PackerKind = "text" | "code" | "image";

export type PackInputItem = {
    chunkId: number;
    documentPath: string;
    fileName: string;
    content: string;
    sectionTitle?: string;
    distance?: number;
    modality?: "text" | "image";
};

export type ContextItem = {
    rank: number;
    chunkId: number;
    path: string;
    fileName: string;
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
    maxCharsPerItem?: number;
    maxTotalChars?: number;
};

const DEFAULT_MAX_CHARS_PER_ITEM = 1200;
const DEFAULT_MAX_TOTAL_CHARS = 12000;
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

function deriveKind(item: PackInputItem): PackerKind {
    if (item.modality === "image") return "image";
    return CODE_LIKE_EXTENSIONS.has(getExtension(item.documentPath)) ? "code" : "text";
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

export function packContext(
    inputs: PackInputItem[],
    options: PackOptions = {}
): { bundle: ContextBundle; markdown: string } {
    const {
        query = "",
        maxCharsPerItem = DEFAULT_MAX_CHARS_PER_ITEM,
        maxTotalChars = DEFAULT_MAX_TOTAL_CHARS,
    } = options;

    const items: ContextItem[] = inputs.map((r, index) => {
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
