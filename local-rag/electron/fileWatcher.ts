import chokidar, { FSWatcher } from "chokidar"
import path from "node:path"
import { fileURLToPath } from "node:url";
import { VectorStore } from "./vectorStore"
import { SidecarStatus } from "./electron"
import { IndexingOptions, IndexingRules } from "./indexingRules";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class FileWatcher {
    private watcher: FSWatcher | null = null
    private rootPaths: string[] = []
    private status: SidecarStatus = "stopped"
    private indexingRulesByRoot = new Map<string, IndexingRules>();
    private indexingOptions: Required<IndexingOptions> = { includeCodeFiles: false, indexAllFiles: false };

    constructor(private readonly vectorStore: VectorStore) { }

    async setPath(newRootPath: string, options: IndexingOptions = {}) {
        if (this.rootPaths.length === 1 && this.rootPaths[0] === newRootPath) return this.getStatus()
        await this.start(newRootPath, options)
        return this.getStatus()
    }

    async start(rootPath: string | string[], options: IndexingOptions = {}) {
        const roots = Array.isArray(rootPath) ? rootPath : [rootPath]
        const normalizedRoots = Array.from(new Set(roots.map((p) => path.resolve(p))))
        if (!normalizedRoots.length) {
            this.status = "error"
            console.error("[fileWatcher] no root paths provided")
            return
        }

        if (this.watcher) {
            await this.stop()
        }

        this.status = "starting"
        this.rootPaths = normalizedRoots
        this.indexingOptions = {
            includeCodeFiles: options.includeCodeFiles ?? false,
            indexAllFiles: options.indexAllFiles ?? false,
        };
        this.indexingRulesByRoot.clear()
        for (const root of this.rootPaths) {
            this.indexingRulesByRoot.set(root, new IndexingRules(root, this.indexingOptions))
        }
        try {
            for (const root of this.rootPaths) {
                await this.vectorStore.indexDirectory(root, this.indexingOptions);
            }
        } catch (error) {
            this.status = "error"
            console.error("[fileWatcher] initial indexing failed:", error)
            return
        }

        this.watcher = chokidar.watch(this.rootPaths, {
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100,
            },
            ignored: (targetPath, stats) => {
                const rules = this.getRulesForPath(targetPath)
                if (!rules) return true;
                if (stats?.isDirectory()) {
                    return rules.shouldSkipDirectory(targetPath);
                }
                return rules.shouldSkipFile(targetPath);
            },
        })

        this.watcher.on("add", async (filePath) => {
            const rules = this.getRulesForPath(filePath)
            if (!shouldIndexFile(filePath, rules)) return
            if (!rules) return
            try {
                const modality = rules.getFileModality(filePath);
                await this.vectorStore.indexFile(filePath, modality ?? undefined)
                console.log("[fileWatcher] indexed added file:", filePath)
            } catch (error) {
                this.status = "error";
                console.error("[fileWatcher] add failed:", filePath, error)
            }
        })

        this.watcher.on("change", async (filePath) => {
            const rules = this.getRulesForPath(filePath)
            if (!shouldIndexFile(filePath, rules)) return
            if (!rules) return
            try {
                const modality = rules.getFileModality(filePath);
                await this.vectorStore.indexFile(filePath, modality ?? undefined)
                console.log("[fileWatcher] reindexed changed file:", filePath)
            } catch (error) {
                this.status = "error";
                console.error("[fileWatcher] change failed:", filePath, error)
            }
        })

        this.watcher.on("unlink", async (filePath) => {
            const rules = this.getRulesForPath(filePath)
            if (!shouldIndexFile(filePath, rules)) return
            if (!rules) return
            try {
                await this.vectorStore.deleteDocument(filePath)
                console.log("[fileWatcher] removed deleted file:", filePath)
            } catch (error) {
                this.status = "error";
                console.error("[fileWatcher] unlink failed:", filePath, error)
            }
        })

        this.watcher.on("error", (error) => {
            this.status = "error"
            console.error("[fileWatcher] watcher error:", error)
        })

        this.status = "running"
    }

    async addPath(newRootPath: string, options: IndexingOptions = {}) {
        const normalized = path.resolve(newRootPath)
        if (this.rootPaths.includes(normalized)) return this.getStatus()
        if (!this.watcher || this.status !== "running") {
            await this.start([normalized], options)
            return this.getStatus()
        }

        const nextOptions = {
            includeCodeFiles: options.includeCodeFiles ?? this.indexingOptions.includeCodeFiles,
            indexAllFiles: options.indexAllFiles ?? this.indexingOptions.indexAllFiles,
        }
        if (
            nextOptions.includeCodeFiles !== this.indexingOptions.includeCodeFiles ||
            nextOptions.indexAllFiles !== this.indexingOptions.indexAllFiles
        ) {
            await this.start([...this.rootPaths, normalized], nextOptions)
            return this.getStatus()
        }

        const rules = new IndexingRules(normalized, this.indexingOptions)
        this.indexingRulesByRoot.set(normalized, rules)
        this.rootPaths = [...this.rootPaths, normalized]
        await this.vectorStore.indexDirectory(normalized, this.indexingOptions)
        this.watcher.add(normalized)
        return this.getStatus()
    }

    async clearIndex() {
        await this.vectorStore.clearIndex()
        return this.getStatus()
    }

    async reindex() {
        if (!this.rootPaths.length) {
            return { ...this.getStatus(), warning: "no_root_path" as const }
        }
        await this.vectorStore.clearIndex()
        await this.start(this.rootPaths, this.indexingOptions)
        return this.getStatus()
    }

    async indexFiles(filePaths: string[]) {
        const normalized = Array.from(new Set(filePaths.map((p) => path.resolve(p))))
        let indexedCount = 0
        let skippedCount = 0
        const details: Array<{ path: string; skipped: boolean; reason?: string }> = []

        for (const filePath of normalized) {
            try {
                const result = await this.vectorStore.indexFile(filePath)
                if (result?.skipped) {
                    skippedCount += 1
                    details.push({ path: filePath, skipped: true, reason: "reason" in result ? result.reason : "unknown" })
                } else {
                    indexedCount += 1
                    details.push({ path: filePath, skipped: false })
                }
            } catch (error) {
                skippedCount += 1
                details.push({ path: filePath, skipped: true, reason: "index_error" })
                console.error("[fileWatcher] manual file index failed:", filePath, error)
            }
        }

        return {
            indexedCount,
            skippedCount,
            details,
            ...this.getStatus(),
        }
    }

    async stop() {
        if (this.watcher) {
            await this.watcher.close()
            this.watcher = null
        }

        this.rootPaths = []
        this.indexingRulesByRoot.clear()
        this.status = "stopped"
    }

    getStatus() {
        return {
            status: this.status,
            rootPath: this.rootPaths[0] ?? null,
            rootPaths: this.rootPaths,
            indexingOptions: this.indexingOptions,
            indexingStats: this.vectorStore.getStats(),
        }
    }

    private getRulesForPath(targetPath: string): IndexingRules | null {
        const resolved = path.resolve(targetPath)
        for (const root of this.rootPaths) {
            if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
                return this.indexingRulesByRoot.get(root) ?? null
            }
        }
        return null
    }
}

function shouldIndexFile(filePath: string, rules: IndexingRules | null) {
    if (!rules) return false;
    if (rules.shouldSkipFile(filePath)) return false;
    const modality = rules.getFileModality(filePath);
    return modality === "text" || modality === "image" || modality === "code";
}