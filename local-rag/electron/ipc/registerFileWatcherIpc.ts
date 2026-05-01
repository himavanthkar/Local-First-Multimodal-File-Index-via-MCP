import { BrowserWindow, dialog, ipcMain } from "electron"
import { fileWatcher } from "../services.js";
import { IndexingOptions } from "../indexingRules.js";

/* - FileWatcher IPC handler -----------------------
*/
export function registerFileWatcherIpc() {
    ipcMain.handle("watcher:start", async (_event, rootPath: string | string[], options?: IndexingOptions) => {
        await fileWatcher.start(rootPath, options)
        return fileWatcher.getStatus()
    })

    ipcMain.handle("watcher:stop", async () => {
        await fileWatcher.stop()
        return fileWatcher.getStatus()
    })

    ipcMain.handle("watcher:status", async () => {
        return fileWatcher.getStatus()
    })

    ipcMain.handle("watcher:pickDirectory", async (event, options?: IndexingOptions, addToExisting = false) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        const result = await dialog.showOpenDialog(win!, {
            properties: ["openDirectory"],
            title: "Choose a folder to watch",
        })

        if (result.canceled || result.filePaths.length === 0) {
            return { canceled: true, path: null, ...fileWatcher.getStatus() }
        }

        const selectedPath = result.filePaths[0]
        if (addToExisting) {
            await fileWatcher.addPath(selectedPath, options)
        } else {
            await fileWatcher.setPath(selectedPath, options)
        }
        return { canceled: false, path: selectedPath, ...fileWatcher.getStatus() }
    })

    ipcMain.handle("watcher:pickFiles", async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        const result = await dialog.showOpenDialog(win!, {
            properties: ["openFile", "multiSelections"],
            title: "Choose files to index",
        })

        if (result.canceled || result.filePaths.length === 0) {
            return {
                canceled: true,
                paths: [] as string[],
                ...fileWatcher.getStatus(),
                indexedCount: 0,
                skippedCount: 0,
                details: [] as Array<{ path: string; skipped: boolean; reason?: string }>,
            }
        }

        const indexResult = await fileWatcher.indexFiles(result.filePaths)
        return {
            canceled: false,
            paths: result.filePaths,
            ...indexResult,
        }
    })

    ipcMain.handle("watcher:clearIndex", async () => {
        return fileWatcher.clearIndex()
    })

    ipcMain.handle("watcher:reindex", async () => {
        return fileWatcher.reindex()
    })
}