import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Resolve the SQLite path Obi writes to via Electron's `app.getPath('userData')`.
 *
 * Resolution order:
 *   1. `OBI_DB_PATH` env var (absolute path to app.db) — explicit override.
 *   2. Packaged Electron build → product name "Obi" → ~/Library/Application Support/Obi/rag/app.db
 *   3. Dev Electron build → "Electron" default name → ~/Library/Application Support/Electron/rag/app.db
 *
 * The first path that actually exists wins. On Linux/Windows we use the
 * platform-conventional userData directories.
 */
export function resolveObiDbPath(): string {
    const envOverride = process.env.OBI_DB_PATH;
    if (envOverride && envOverride.trim()) return path.resolve(envOverride);

    const candidates = userDataCandidates().map((dir) =>
        path.join(dir, "rag", "app.db")
    );

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    // Fall back to the most likely production path even if missing, so the
    // error message points the user at the right location.
    return candidates[0] ?? path.join(os.homedir(), "Obi", "rag", "app.db");
}

function userDataCandidates(): string[] {
    const home = os.homedir();
    const platform = process.platform;
    const names = ["Obi", "Electron"];

    if (platform === "darwin") {
        const base = path.join(home, "Library", "Application Support");
        return names.map((name) => path.join(base, name));
    }
    if (platform === "win32") {
        const base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
        return names.map((name) => path.join(base, name));
    }
    // linux / other
    const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
    return names.map((name) => path.join(xdg, name));
}

export type SqliteDatabase = Database.Database;

export function openObiDb(): SqliteDatabase {
    const dbPath = resolveObiDbPath();
    if (!fs.existsSync(dbPath)) {
        throw new Error(
            `Obi database not found at ${dbPath}. ` +
                `Open Obi at least once and index a folder, or set OBI_DB_PATH to your app.db path.`
        );
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("journal_mode = WAL");
    return db;
}
