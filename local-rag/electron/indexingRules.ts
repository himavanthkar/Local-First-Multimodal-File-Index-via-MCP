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
const CODE_FILE_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".java",
    ".go",
    ".rs",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".rb",
]);

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
        const extension = path.extname(filePath).toLowerCase();
        if (TEXT_FILE_EXTENSIONS.has(extension)) return "text";
        if (this.options.includeCodeFiles && CODE_FILE_EXTENSIONS.has(extension)) return "code";
        if (IMAGE_FILE_EXTENSIONS.has(extension)) return "image";
        if (this.options.indexAllFiles) return "text";
        return null;
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

