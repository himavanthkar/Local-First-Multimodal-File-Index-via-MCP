import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { imageCaptioner, vectorStore } from "../services.js";

/* - VectorStore(RAG) IPC handler -----------------------
*/
export function registerVectorStoreIpc() {
    ipcMain.handle("rag:indexDirectory", async (_event, rootPath: string) => {
        return vectorStore.indexDirectory(rootPath)
    })

    ipcMain.handle("rag:indexFile", async (_event, filePath: string) => {
        return vectorStore.indexFile(filePath)
    })

    ipcMain.handle("rag:deleteDocument", async (_event, filePath: string) => {
        return vectorStore.deleteDocument(filePath)
    })

    ipcMain.handle("rag:search", async (_event, query: string, limit = 5) => {
        return vectorStore.search(query, limit)
    })

    ipcMain.handle("rag:describeImage", async (_event, imagePath: string) => {
        return imageCaptioner.describeImage(imagePath)
    })

    ipcMain.handle("rag:answerImageQuestion", async (_event, imagePath: string, question: string) => {
        return imageCaptioner.answerQuestion(imagePath, question)
    })

    ipcMain.handle("rag:extractImageText", async (_event, imagePath: string) => {
        return imageCaptioner.extractText(imagePath)
    })

    ipcMain.handle("rag:detectImageObjects", async (_event, imagePath: string) => {
        return imageCaptioner.detectObjects(imagePath)
    })

    ipcMain.handle("rag:getImagePreviewDataUrl", async (_event, imagePath: string) => {
        try {
            const ext = path.extname(imagePath).toLowerCase();
            const mimeByExt: Record<string, string> = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".svg": "image/svg+xml",
            };
            const mime = mimeByExt[ext];
            if (!mime) return null;
            const file = fs.readFileSync(imagePath);
            const base64 = file.toString("base64");
            return `data:${mime};base64,${base64}`;
        } catch {
            return null;
        }
    })

    ipcMain.handle("rag:getSourcePreview", async (_event, filePath: string) => {
        try {
            const ext = path.extname(filePath).toLowerCase();
            const imageMimeByExt: Record<string, string> = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp",
                ".svg": "image/svg+xml",
            };

            const imageMime = imageMimeByExt[ext];
            if (imageMime) {
                const file = fs.readFileSync(filePath);
                const base64 = file.toString("base64");
                return {
                    kind: "image" as const,
                    imageDataUrl: `data:${imageMime};base64,${base64}`,
                    text: null,
                };
            }

            const textLikeExts = new Set([
                ".txt", ".md", ".mdx", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx",
                ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".css",
                ".scss", ".html", ".xml", ".yaml", ".yml", ".toml", ".ini", ".log",
                ".sql"
            ]);
            if (!textLikeExts.has(ext)) {
                return { kind: "binary" as const, imageDataUrl: null, text: null };
            }

            const raw = fs.readFileSync(filePath, "utf8");
            const normalized = raw.replace(/\r\n/g, "\n");
            const preview = normalized.split("\n").slice(0, 10).join("\n").slice(0, 900).trim();
            return {
                kind: "text" as const,
                imageDataUrl: null,
                text: preview || null,
            };
        } catch {
            return { kind: "unavailable" as const, imageDataUrl: null, text: null };
        }
    })

    ipcMain.handle("rag:stats", async () => {
        return vectorStore.getStats()
    })

    ipcMain.handle("rag:recentIndexedFiles", async (_event, limit = 12) => {
        return vectorStore.getRecentIndexedFiles(limit)
    })

    ipcMain.handle("rag:skipEvents", async (_event, limit = 100) => {
        return vectorStore.getRecentSkipEvents(limit)
    })

    ipcMain.handle("rag:imageEmbeddingStatus", async () => {
        return vectorStore.getImageEmbeddingStatus()
    })
}