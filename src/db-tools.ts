/**
 * MCP tools backed by the local Fedlex SQLite database.
 * Falls back gracefully when the database has not yet been built.
 */
import Database, { type Database as DB } from "better-sqlite3";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir  = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.FEDLEX_DB_PATH ?? resolve(__dir, "../data/fedlex.sqlite");

// Singleton — opened once on first use, readonly
let _db: DB | null = null;

function getDb(): DB {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Fedlex SQLite database not found at ${DB_PATH}. ` +
      `Run 'npm run ingest' to build it, or download a pre-built release from GitHub.`
    );
  }
  _db = new Database(DB_PATH, { readonly: true });
  _db.pragma("journal_mode = WAL");
  return _db;
}

// ---------------------------------------------------------------------------
// Tool: search_provisions — FTS5 full-text search across all article text
// ---------------------------------------------------------------------------
export function searchProvisions(params: {
  query:    string;
  limit?:   number;
  sr_number?: string;
}) {
  const db     = getDb();
  const limit  = Math.min(params.limit ?? 20, 100);
  const q      = params.query.replace(/['"*^]/g, " ").trim();
  if (!q) throw new Error("query must not be empty");

  // Wrap in quotes for exact phrase matching when multi-word
  const ftsQuery = q.includes(" ") ? `"${q}"` : q;

  let sql: string;
  let queryParams: unknown[];

  if (params.sr_number) {
    sql = `
      SELECT p.id, p.sr_number, p.article_number, p.article_title,
             snippet(provisions_fts, 0, '<b>', '</b>', '…', 32) AS snippet,
             l.title AS law_title, l.abbreviation, l.eli_uri,
             bm25(provisions_fts) AS rank
      FROM provisions_fts
      JOIN provisions p ON provisions_fts.rowid = p.id
      JOIN laws l       ON p.law_id = l.id
      WHERE provisions_fts MATCH ?
        AND p.sr_number = ?
      ORDER BY rank
      LIMIT ?`;
    queryParams = [ftsQuery, params.sr_number, limit];
  } else {
    sql = `
      SELECT p.id, p.sr_number, p.article_number, p.article_title,
             snippet(provisions_fts, 0, '<b>', '</b>', '…', 32) AS snippet,
             l.title AS law_title, l.abbreviation, l.eli_uri,
             bm25(provisions_fts) AS rank
      FROM provisions_fts
      JOIN provisions p ON provisions_fts.rowid = p.id
      JOIN laws l       ON p.law_id = l.id
      WHERE provisions_fts MATCH ?
      ORDER BY rank
      LIMIT ?`;
    queryParams = [ftsQuery, limit];
  }

  const rows = db.prepare(sql).all(...queryParams) as Array<{
    id: number; sr_number: string; article_number: string;
    article_title: string; snippet: string;
    law_title: string; abbreviation: string; eli_uri: string; rank: number;
  }>;

  return {
    query:   params.query,
    count:   rows.length,
    results: rows.map((r) => ({
      sr_number:      r.sr_number,
      article_number: r.article_number,
      article_title:  r.article_title,
      snippet:        r.snippet,
      law_title:      r.law_title,
      abbreviation:   r.abbreviation,
      eli_uri:        r.eli_uri,
      relevance_score: Math.round(-r.rank * 1000) / 1000,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool: lookup_definition — find definitions of a legal term
// ---------------------------------------------------------------------------
export function lookupDefinition(params: {
  term:   string;
  limit?: number;
}) {
  const db    = getDb();
  const limit = Math.min(params.limit ?? 20, 50);

  const rows = db.prepare(`
    SELECT d.term, d.definition, d.sr_number, l.title AS law_title,
           l.abbreviation, l.eli_uri
    FROM definitions d
    JOIN laws l ON d.law_id = l.id
    WHERE d.term LIKE ?
    ORDER BY d.sr_number
    LIMIT ?
  `).all(`%${params.term}%`, limit) as Array<{
    term: string; definition: string; sr_number: string;
    law_title: string; abbreviation: string; eli_uri: string;
  }>;

  return {
    term:    params.term,
    count:   rows.length,
    results: rows.map((r) => ({
      term:         r.term,
      definition:   r.definition,
      sr_number:    r.sr_number,
      law_title:    r.law_title,
      abbreviation: r.abbreviation,
      eli_uri:      r.eli_uri,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool: find_eu_references — find Swiss laws implementing EU acts
// ---------------------------------------------------------------------------
export function findEuReferences(params: {
  eu_identifier?: string;
  eu_type?:       string;
  limit?:         number;
}) {
  const db    = getDb();
  const limit = Math.min(params.limit ?? 30, 100);

  const conditions: string[] = [];
  const vals: unknown[] = [];

  if (params.eu_identifier) {
    conditions.push("e.eu_identifier LIKE ?");
    vals.push(`%${params.eu_identifier.replace(/['"]/g, "")}%`);
  }
  if (params.eu_type) {
    conditions.push("e.eu_type = ?");
    vals.push(params.eu_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db.prepare(`
    SELECT e.eu_identifier, e.eu_type, e.sr_number,
           l.title AS law_title, l.abbreviation, l.eli_uri,
           COUNT(*) AS reference_count
    FROM eu_references e
    JOIN laws l ON e.law_id = l.id
    ${where}
    GROUP BY e.eu_identifier, e.sr_number
    ORDER BY e.eu_identifier, e.sr_number
    LIMIT ?
  `).all(...vals, limit) as Array<{
    eu_identifier: string; eu_type: string; sr_number: string;
    law_title: string; abbreviation: string; eli_uri: string;
    reference_count: number;
  }>;

  return {
    filter: { eu_identifier: params.eu_identifier, eu_type: params.eu_type },
    count:  rows.length,
    results: rows.map((r) => ({
      eu_identifier:   r.eu_identifier,
      eu_type:         r.eu_type,
      sr_number:       r.sr_number,
      law_title:       r.law_title,
      abbreviation:    r.abbreviation,
      eli_uri:         r.eli_uri,
      reference_count: r.reference_count,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tool: get_db_stats — database statistics and last ingestion info
// ---------------------------------------------------------------------------
export function getDbStats() {
  const db = getDb();

  const laws      = db.prepare("SELECT COUNT(*) AS n FROM laws").get() as { n: number };
  const inForce   = db.prepare("SELECT COUNT(*) AS n FROM laws WHERE is_in_force = 1").get() as { n: number };
  const pdfOnly   = db.prepare("SELECT COUNT(*) AS n FROM sr_census WHERE status = 'pdf-only'").get() as { n: number };
  const noContent = db.prepare("SELECT COUNT(*) AS n FROM sr_census WHERE status = 'no-content'").get() as { n: number };
  const provs     = db.prepare("SELECT COUNT(*) AS n FROM provisions").get() as { n: number };
  const defs      = db.prepare("SELECT COUNT(*) AS n FROM definitions").get() as { n: number };
  const euRefs    = db.prepare("SELECT COUNT(*) AS n FROM eu_references").get() as { n: number };
  const uniqueEu  = db.prepare("SELECT COUNT(DISTINCT eu_identifier) AS n FROM eu_references").get() as { n: number };

  const byType = db.prepare(`
    SELECT law_type, COUNT(*) AS n FROM laws GROUP BY law_type ORDER BY n DESC
  `).all() as { law_type: string; n: number }[];

  interface LogRow {
    run_at: string; language: string;
    laws_ingested: number; provisions_total: number; duration_seconds: number;
  }
  const lastRun = db.prepare(
    "SELECT * FROM ingestion_log ORDER BY id DESC LIMIT 1"
  ).get() as LogRow | undefined;

  const dbSize = db.prepare(
    "SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()"
  ).get() as { size: number };

  return {
    database: {
      path:        DB_PATH,
      size_bytes:  dbSize?.size ?? 0,
      size_mb:     Math.round((dbSize?.size ?? 0) / 1024 / 1024 * 10) / 10,
      last_ingested: lastRun?.run_at ?? "never",
      language:    lastRun?.language ?? "unknown",
    },
    counts: {
      laws_total:        laws.n,
      laws_in_force:     inForce.n,
      laws_pdf_only:     pdfOnly.n,
      laws_no_content:   noContent.n,
      provisions:        provs.n,
      definitions:       defs.n,
      eu_references:     euRefs.n,
      unique_eu_acts:    uniqueEu.n,
    },
    laws_by_type: Object.fromEntries(byType.map((r) => [r.law_type, r.n])),
    last_ingestion: lastRun
      ? {
          run_at:         lastRun.run_at,
          laws_ingested:  lastRun.laws_ingested,
          provisions:     lastRun.provisions_total,
          duration_s:     lastRun.duration_seconds,
        }
      : null,
  };
}
