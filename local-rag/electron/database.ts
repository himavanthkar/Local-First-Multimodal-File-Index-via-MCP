import Database from 'better-sqlite3';
import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import * as sqliteVec from "sqlite-vec";

let db: Database.Database | null = null;

function getUserDataPath() {
    return app.getPath("userData")
}

function getDbPath() {
    const dataDir = path.join(getUserDataPath(), "rag")
    fs.mkdirSync(dataDir, { recursive: true })
    return path.join(dataDir, "app.db")
}

export function getDb() {
    if (!db) {
        throw new Error("Database not initialized. Call initDatabase() first.")
    }
    return db
}

export function initDatabase() {
    if (db) return db;

    const dbPath = getDbPath();
    db = new Database(dbPath);

    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    sqliteVec.load(db);


    createSchema(db);

    console.log("DB path:", dbPath);
    return db;
}

function createSchema(db: Database.Database) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      indexed_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      section_title TEXT DEFAULT '',
      char_start INTEGER NOT NULL DEFAULT 0,
      char_end INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
      UNIQUE(document_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS image_documents (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      indexed_at_ms INTEGER NOT NULL,
      width INTEGER,
      height INTEGER
    );

    CREATE TABLE IF NOT EXISTS gmail_messages (
      id INTEGER PRIMARY KEY,
      gmail_message_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      subject TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL DEFAULT '',
      sent_at_ms INTEGER NOT NULL DEFAULT 0,
      internal_date_ms INTEGER NOT NULL DEFAULT 0,
      label_ids_json TEXT NOT NULL DEFAULT '[]',
      indexed_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      index_count INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS gmail_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_synced_at_ms INTEGER NOT NULL DEFAULT 0,
      last_history_id TEXT
    );

    CREATE TABLE IF NOT EXISTS index_skip_events (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      modality TEXT,
      skipped_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_image_documents_path ON image_documents(path);
    CREATE INDEX IF NOT EXISTS idx_gmail_messages_path ON gmail_messages(path);
    CREATE INDEX IF NOT EXISTS idx_gmail_messages_internal_date ON gmail_messages(internal_date_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_index_skip_events_time ON index_skip_events(skipped_at_ms DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      chunk_id UNINDEXED,
      document_path UNINDEXED,
      tokenize = 'unicode61'
    );

    -- sqlite-vec virtual table
    -- Adjust 768 to match your embedding size.
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS image_embeddings_clip USING vec0(
      image_id INTEGER PRIMARY KEY,
      embedding FLOAT[512]
    );
  `)

    addColumnIfMissing(db, "chunks", "section_title", "TEXT DEFAULT ''");
    addColumnIfMissing(db, "chunks", "char_start", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "chunks", "char_end", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "documents", "index_count", "INTEGER NOT NULL DEFAULT 1");
    addColumnIfMissing(db, "image_documents", "index_count", "INTEGER NOT NULL DEFAULT 1");
    addColumnIfMissing(db, "gmail_messages", "index_count", "INTEGER NOT NULL DEFAULT 1");
}

function addColumnIfMissing(
    db: Database.Database,
    tableName: string,
    columnName: string,
    columnDefinition: string
) {
    const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    const exists = tableInfo.some((column) => column.name === columnName);
    if (!exists) {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    }
}