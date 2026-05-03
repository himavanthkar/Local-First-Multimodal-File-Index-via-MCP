import fs from "node:fs";
import path from "node:path";
import ignore, { Ignore } from "ignore";

const ALWAYS_IGNORED_DIRS = new Set([
    ".git",
    "node_modules",
]);

const DEFAULT_IGNORED_DIRS = new Set([
    ".next",
    ".nuxt",
    "dist",
    "build",
    "target",
    "out",
    ".cache",
    ".tmp",
    "tmp",
    "__pycache__",
    ".venv",
    "venv",
    "env",
    "Library",
    "AppData",
]);

const DEFAULT_IGNORED_FILE_NAMES = new Set([
    ".DS_Store",
    "Thumbs.db",
]);

const DEFAULT_IGNORED_EXTENSIONS = new Set([
    ".pyc",
    ".class",
    ".o",
    ".bin",
    ".dylib",
    ".dll",
    ".so",
    ".exe",
]);

const TEXT_FILE_EXTENSIONS = new Set([
    ".pdf",
    ".xlsx",
    ".xls",
    ".txt",
    ".md",
    ".mdx",
    ".json",
    ".csv",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".log",
    ".ini",
    ".sql",
]);
const IMAGE_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Extensions indexed as code when includeCodeFiles is on (web, mobile, scripts, infra). */
export const CODE_FILE_EXTENSIONS = new Set([
    // JavaScript / TypeScript
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    // Markup / style / web components
    ".html",
    ".htm",
    ".vue",
    ".svelte",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".styl",
    // Systems / app languages
    ".py",
    ".java",
    ".kt",
    ".kts",
    ".go",
    ".rs",
    ".c",
    ".cpp",
    ".cc",
    ".cxx",
    ".h",
    ".hpp",
    ".hh",
    ".cs",
    ".fs",
    ".fsx",
    ".vb",
    ".swift",
    ".m",
    ".mm",
    ".dart",
    ".rb",
    ".php",
    ".scala",
    ".sc",
    ".clj",
    ".cljs",
    ".ex",
    ".exs",
    ".erl",
    ".hrl",
    ".hs",
    ".elm",
    ".lua",
    ".pl",
    ".pm",
    ".r",
    ".jl",
    // Shell / automation
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".ps1",
    ".psm1",
    ".bat",
    ".cmd",
    // Config-as-code / data for dev
    ".graphql",
    ".gql",
    ".proto",
    ".prisma",
    ".tf",
    ".tfvars",
    ".hcl",
    ".nix",
    ".cmake",
    ".bzl",
    ".star",
    ".zig",
    ".nim",
    ".templ",
]);

/**
 * Code files whose basename must win over TEXT (e.g. .txt / extensionless).
 * Do not list *.json / *.toml here — those stay normal TEXT indexing.
 */
const CODE_BASENAME_OVERRIDES = new Set([
    "dockerfile",
    "containerfile",
    "makefile",
    "gnumakefile",
    "cmakelists.txt",
    "rakefile",
    "gemfile",
    "gemfile.lock",
    "podfile",
    "vagrantfile",
    "justfile",
    "procfile",
    "jenkinsfile",
    "bazel.build",
    "build.bazel",
    "workspace",
    "meson.build",
    "dune",
    "dune-project",
    "cargo.lock",
    "go.mod",
    "go.sum",
    "go.work",
    "go.work.sum",
    "yarn.lock",
    "pnpm-workspace.yaml",
    "poetry.lock",
    "pipfile.lock",
    "composer.lock",
]);

export type ResolveModalityOptions = Pick<Required<IndexingOptions>, "includeCodeFiles" | "indexAllFiles">;

/** Single source of truth for path → modality (same rules as IndexingRules.getFileModality). */
export function resolveFileModality(filePath: string, options: ResolveModalityOptions): IndexedModality | null {
    const extension = path.extname(filePath).toLowerCase();
    const baseLower = path.basename(filePath).toLowerCase();

    if (IMAGE_FILE_EXTENSIONS.has(extension)) return "image";

    if (options.includeCodeFiles) {
        if (CODE_BASENAME_OVERRIDES.has(baseLower)) return "code";
        if (CODE_FILE_EXTENSIONS.has(extension)) return "code";
    }

    if (TEXT_FILE_EXTENSIONS.has(extension)) return "text";
    if (options.indexAllFiles) return "text";
    return null;
}

/** Use code-aware chunking (boundaries) for these paths when includeCodeFiles would index them. */
export function shouldChunkAsCode(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    const baseLower = path.basename(filePath).toLowerCase();
    if (CODE_BASENAME_OVERRIDES.has(baseLower)) return true;
    return CODE_FILE_EXTENSIONS.has(extension);
}

export type IndexedModality = "text" | "image" | "code";
export type IndexingOptions = {
    includeCodeFiles?: boolean;
    indexAllFiles?: boolean;
};

export class IndexingRules {
    private readonly rootPath: string;
    private readonly gitIgnoreMatcher: Ignore;
    private readonly options: Required<IndexingOptions>;

    constructor(rootPath: string, options: IndexingOptions = {}) {
        this.rootPath = path.resolve(rootPath);
        this.options = {
            includeCodeFiles: options.includeCodeFiles ?? false,
            indexAllFiles: options.indexAllFiles ?? false,
        };
        this.gitIgnoreMatcher = this.buildGitIgnoreMatcher();
    }

    shouldSkipDirectory(dirPath: string): boolean {
        const resolvedPath = path.resolve(dirPath);
        if (!resolvedPath.startsWith(this.rootPath)) return true;
        const relativePath = this.toRelativePath(resolvedPath);
        if (!relativePath) return false;
        const baseName = path.basename(resolvedPath);

        if (ALWAYS_IGNORED_DIRS.has(baseName)) return true;
        if (this.options.indexAllFiles) return false;
        if (DEFAULT_IGNORED_DIRS.has(baseName)) return true;
        return relativePath.length > 0 && this.gitIgnoreMatcher.ignores(`${relativePath}/`);
    }

    shouldSkipFile(filePath: string): boolean {
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(this.rootPath)) return true;
        const baseName = path.basename(resolvedPath);
        if (DEFAULT_IGNORED_FILE_NAMES.has(baseName)) return true;
        const extension = path.extname(resolvedPath).toLowerCase();
        if (DEFAULT_IGNORED_EXTENSIONS.has(extension)) return true;
        // Keep PDFs indexable even when repos ignore them in .gitignore.
        if (extension === ".pdf") return false;
        // Keep common image files indexable even when repos ignore generated assets.
        if (IMAGE_FILE_EXTENSIONS.has(extension)) return false;
        if (this.options.indexAllFiles) return false;

        const relativePath = this.toRelativePath(resolvedPath);
        if (!relativePath) return false;
        return this.gitIgnoreMatcher.ignores(relativePath);
    }

    getFileModality(filePath: string): IndexedModality | null {
        return resolveFileModality(filePath, this.options);
    }

    private toRelativePath(targetPath: string): string {
        const relativePath = path.relative(this.rootPath, targetPath);
        return relativePath.split(path.sep).join("/");
    }

    private buildGitIgnoreMatcher(): Ignore {
        const matcher = ignore();
        const gitIgnorePath = path.join(this.rootPath, ".gitignore");
        if (!fs.existsSync(gitIgnorePath)) return matcher;

        const patterns = fs
            .readFileSync(gitIgnorePath, "utf8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#"));

        matcher.add(patterns);
        return matcher;
    }
}

