/**
 * Fedlex SQLite ingestion pipeline
 *
 * Builds a portable SQLite database of all Swiss federal legislation:
 *   - All ConsolidationAbstract entries (acts, ordinances, treaties …)
 *   - Parsed provisions (articles) with FTS5 full-text index
 *   - Extracted legal definitions
 *   - Extracted EU cross-references
 *
 * Usage:
 *   npx tsx scripts/ingest.ts [--lang de|fr|it] [--concurrency 5] [--db ./data/fedlex.sqlite]
 */
import Database from "better-sqlite3";
import { parse as parseHtml } from "node-html-parser";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { sparqlQuery, sparqlEscapeString } from "../src/sparql.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dir, "../data/fedlex.sqlite");

const args = process.argv.slice(2);
const getArg = (flag: string, fallback: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : fallback;
};

const DB_PATH = process.env.FEDLEX_DB_PATH ?? getArg("--db", DEFAULT_DB);
const LANG    = getArg("--lang", "de");
const CONCURRENCY = parseInt(getArg("--concurrency", "5"), 10);

const LANG_URI: Record<string, string> = {
  de: "http://publications.europa.eu/resource/authority/language/DEU",
  fr: "http://publications.europa.eu/resource/authority/language/FRA",
  it: "http://publications.europa.eu/resource/authority/language/ITA",
};
const HTML_FORMAT = "http://publications.europa.eu/resource/authority/file-type/HTML";
const PDF_FORMAT  = "http://publications.europa.eu/resource/authority/file-type/PDF";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS laws (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  sr_number                TEXT    NOT NULL UNIQUE,
  eli_uri                  TEXT    NOT NULL,
  title                    TEXT,
  abbreviation             TEXT,
  date_entry_in_force      TEXT,
  date_no_longer_in_force  TEXT,
  is_in_force              INTEGER NOT NULL DEFAULT 1,
  latest_consolidation_uri TEXT,
  latest_consolidation_date TEXT,
  html_url                 TEXT,
  pdf_url                  TEXT,
  xml_url                  TEXT,
  law_type                 TEXT,
  sr_chapter               TEXT,
  language                 TEXT    NOT NULL DEFAULT 'de',
  ingested_at              TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS provisions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  law_id         INTEGER NOT NULL REFERENCES laws(id) ON DELETE CASCADE,
  sr_number      TEXT    NOT NULL,
  article_id     TEXT,
  article_number TEXT,
  article_title  TEXT,
  article_text   TEXT    NOT NULL,
  language       TEXT    NOT NULL DEFAULT 'de',
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_provisions_law ON provisions(law_id);
CREATE INDEX IF NOT EXISTS idx_provisions_sr  ON provisions(sr_number);

CREATE VIRTUAL TABLE IF NOT EXISTS provisions_fts USING fts5(
  article_text,
  article_title,
  content = provisions,
  content_rowid = id,
  tokenize = 'unicode61 remove_diacritics 1'
);

CREATE TABLE IF NOT EXISTS definitions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  law_id           INTEGER NOT NULL REFERENCES laws(id) ON DELETE CASCADE,
  provision_id     INTEGER REFERENCES provisions(id) ON DELETE SET NULL,
  sr_number        TEXT    NOT NULL,
  term             TEXT    NOT NULL,
  definition       TEXT    NOT NULL,
  language         TEXT    NOT NULL DEFAULT 'de'
);

CREATE INDEX IF NOT EXISTS idx_definitions_term ON definitions(term COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS eu_references (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  law_id          INTEGER NOT NULL REFERENCES laws(id) ON DELETE CASCADE,
  provision_id    INTEGER REFERENCES provisions(id) ON DELETE SET NULL,
  sr_number       TEXT    NOT NULL,
  eu_identifier   TEXT    NOT NULL,
  eu_type         TEXT,
  eu_title        TEXT,
  language        TEXT    NOT NULL DEFAULT 'de'
);

CREATE INDEX IF NOT EXISTS idx_eu_refs_id ON eu_references(eu_identifier);

CREATE TABLE IF NOT EXISTS ingestion_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at            TEXT    NOT NULL,
  language          TEXT    NOT NULL,
  laws_total        INTEGER NOT NULL DEFAULT 0,
  laws_ingested     INTEGER NOT NULL DEFAULT 0,
  laws_pdf_only     INTEGER NOT NULL DEFAULT 0,
  laws_error        INTEGER NOT NULL DEFAULT 0,
  provisions_total  INTEGER NOT NULL DEFAULT 0,
  definitions_total INTEGER NOT NULL DEFAULT 0,
  eu_refs_total     INTEGER NOT NULL DEFAULT 0,
  duration_seconds  REAL    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sr_census (
  sr_number        TEXT    PRIMARY KEY,
  eli_uri          TEXT    NOT NULL,
  title            TEXT,
  has_html         INTEGER NOT NULL DEFAULT 0,
  has_pdf          INTEGER NOT NULL DEFAULT 0,
  is_in_force      INTEGER NOT NULL DEFAULT 1,
  status           TEXT    NOT NULL DEFAULT 'unknown'
);
`;

// ---------------------------------------------------------------------------
// Law type detection from title
// ---------------------------------------------------------------------------
const TYPE_KEYWORDS: Record<string, string[]> = {
  Act:        ["gesetz", "code", "loi", "legge", "codice"],
  Ordinance:  ["verordnung", "ordonnance", "ordinanza", "reglement", "règlement"],
  Treaty:     ["abkommen", "vertrag", "accord", "accordo", "convention", "konvention", "übereinkommen"],
  Decree:     ["beschluss", "entscheid", "décision", "decisione", "arrêté", "decreto"],
  Regulation: ["vorschriften", "bestimmungen", "dispositions"],
};

function inferLawType(title: string): string {
  const t = title.toLowerCase();
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    if (keywords.some((kw) => t.includes(kw))) return type;
  }
  return "Other";
}

// ---------------------------------------------------------------------------
// HTML parser — extract provisions from a Fedlex HTML document
// ---------------------------------------------------------------------------
interface Provision {
  articleId:     string;
  articleNumber: string;
  articleTitle:  string;
  articleText:   string;
  sortOrder:     number;
}

function parseProvisions(html: string): Provision[] {
  const root = parseHtml(html);
  const provisions: Provision[] = [];
  let order = 0;

  // Remove footnotes before parsing
  root.querySelectorAll(".footnotes").forEach((el) => el.remove());

  for (const article of root.querySelectorAll("article")) {
    const artId = article.getAttribute("id") ?? "";

    // Extract article number from the first <b> inside the h6 heading anchor
    const headingAnchor = article.querySelector("h6.heading a");
    const rawHeadingText = headingAnchor?.text?.trim() ?? "";

    // Pattern: "Art. 1  Title text" or "§ 1  Title text"
    const numMatch = rawHeadingText.match(/^(?:Art(?:icle)?\.?\s*|§\s*)(\w+(?:\s*\w+)?)/i);
    const articleNumber = numMatch ? numMatch[1].trim() : artId.replace(/^art_/, "");
    const articleTitle = rawHeadingText
      .replace(/^(?:Art(?:icle)?\.?\s*|§\s*)\w+(?:\s*\w+)?\s*/i, "")
      .trim();

    // Gather body text from paragraphs inside the collapseable div
    // (excludes footnotes, which we already removed)
    const paragraphs = article
      .querySelectorAll("p, div.absatz")
      .filter((el) => {
        const cls = el.getAttribute("class") ?? "";
        // Only "absatz*" paragraphs or unlabelled body paragraphs
        return (
          cls.includes("absatz") ||
          cls.includes("zifferrmii") ||
          cls.includes("man-template-tab-krpr")
        );
      });

    const textParts = paragraphs
      .map((p) => p.text.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 2);

    if (textParts.length === 0) continue;

    provisions.push({
      articleId: artId,
      articleNumber,
      articleTitle,
      articleText: textParts.join("\n"),
      sortOrder: order++,
    });
  }

  return provisions;
}

// ---------------------------------------------------------------------------
// Definition extractor
// ---------------------------------------------------------------------------
interface Definition {
  term:       string;
  definition: string;
}

// Patterns for German, French, Italian
const DEF_PATTERNS: RegExp[] = [
  // German: "Als «Term» gilt..." / "gilt als X ..."
  /[«»„""‹›]([^«»„""‹›]{2,80})[«»„""‹›]\s*(?:gilt|sind|werden|ist)\s+([^.;]{10,300})/gi,
  // German: "Im Sinne dieses Gesetzes gilt als X..."
  /[Ii]m\s+Sinne\s+(?:dieses|dieser|des)\s+\w+\s+(?:gilt\s+als|versteht\s+man\s+unter|bedeutet)\s+[«»„""]([^«»„""]{2,60})[«»„""]\s*:?\s*([^.;]{10,300})/gi,
  // French
  /[«»]([^«»]{2,80})[«»]\s*(?:s['']entend|désigne|signifie)\s+([^.;]{10,300})/gi,
  // Italian
  /[«»]([^«»]{2,80})[«»]\s*(?:si intende|comprende|designa)\s+([^.;]{10,300})/gi,
];

function extractDefinitions(text: string): Definition[] {
  const defs: Definition[] = [];
  const seen = new Set<string>();
  for (const pattern of DEF_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const term = m[1].trim();
      const def  = m[2].trim().slice(0, 400);
      if (term.length < 2 || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      defs.push({ term, definition: def });
    }
  }
  return defs;
}

// ---------------------------------------------------------------------------
// EU reference extractor
// ---------------------------------------------------------------------------
interface EuRef {
  euIdentifier: string;
  euType:       string;
}

const EU_PATTERN =
  /(?:(Richtlinie|Verordnung|Beschluss|directive|règlement|décision|direttiva|regolamento|decisione)\s+)?(?:\(EU\)\s+)?(?:Nr\.\s*)?(\d{4}\/[\d]+(?:\/EU|\/EG|\/EWG|\/EURATOM|\/UE)?)/gi;

function extractEuRefs(text: string): EuRef[] {
  const refs: EuRef[] = [];
  const seen = new Set<string>();
  EU_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EU_PATTERN.exec(text)) !== null) {
    const id  = m[2].toUpperCase();
    const raw = (m[1] ?? "").toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    let euType = "Unknown";
    if (/richtlinie|directive|direttiva/.test(raw)) euType = "Directive";
    else if (/verordnung|règlement|regolamento/.test(raw)) euType = "Regulation";
    else if (/beschluss|décision|decisione/.test(raw)) euType = "Decision";
    refs.push({ euIdentifier: id, euType });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Batch concurrency helper
// ---------------------------------------------------------------------------
async function inBatches<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, idx: number) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(
      items.slice(i, i + concurrency).map((item, j) => fn(item, i + j))
    );
  }
}

// ---------------------------------------------------------------------------
// Fetch all SR entries via SPARQL (paginated)
// ---------------------------------------------------------------------------
interface LawMeta {
  uri:          string;
  srNumber:     string;
  title:        string;
  abbreviation: string;
  dateInForce:  string;
  dateEnd:      string;
}

async function fetchAllLaws(lang: string): Promise<LawMeta[]> {
  console.log("⚡ Querying all ConsolidationAbstract entries from Fedlex SPARQL…");
  const langUri = LANG_URI[lang] ?? LANG_URI["de"];
  const laws: LawMeta[] = [];
  let offset = 0;
  const pageSize = 2000;

  while (true) {
    const q = `
PREFIX rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos:  <http://www.w3.org/2004/02/skos/core#>

SELECT DISTINCT ?uri ?notation ?title ?abbrev ?dateInForce ?dateEnd WHERE {
  ?uri rdf:type jolux:ConsolidationAbstract ;
       jolux:classifiedByTaxonomyEntry ?entry ;
       jolux:isRealizedBy ?expr .
  ?entry skos:notation ?notation .
  ?expr jolux:language <${langUri}> ;
        jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbrev . }
  OPTIONAL { ?uri jolux:dateEntryInForce ?dateInForce . }
  OPTIONAL { ?uri jolux:dateNoLongerInForce ?dateEnd . }
}
ORDER BY ASC(?notation)
LIMIT ${pageSize}
OFFSET ${offset}`;

    const result = await sparqlQuery(q);
    const batch = result.results.bindings;
    if (batch.length === 0) break;

    for (const b of batch) {
      laws.push({
        uri:          b.uri?.value ?? "",
        srNumber:     b.notation?.value ?? "",
        title:        b.title?.value ?? "",
        abbreviation: b.abbrev?.value ?? "",
        dateInForce:  b.dateInForce?.value ?? "",
        dateEnd:      b.dateEnd?.value ?? "",
      });
    }

    console.log(`  Fetched ${laws.length} laws so far (page offset ${offset})…`);
    offset += pageSize;
    if (batch.length < pageSize) break;
  }

  console.log(`✅ Found ${laws.length} total laws.`);
  return laws;
}

// ---------------------------------------------------------------------------
// Fetch latest consolidation + HTML/PDF URLs for a batch of URIs
// ---------------------------------------------------------------------------
interface ConsolidationInfo {
  srUri:            string;
  consolidationUri: string;
  consDate:         string;
  htmlUrl:          string;
  pdfUrl:           string;
}

async function fetchConsolidations(
  uris: string[],
  lang: string
): Promise<Map<string, ConsolidationInfo>> {
  if (uris.length === 0) return new Map();
  const langUri = LANG_URI[lang] ?? LANG_URI["de"];
  const valuesClause = uris.map((u) => `<${u}>`).join(" ");

  const q = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>

SELECT ?srUri ?consUri ?consDate ?htmlUrl ?pdfUrl WHERE {
  VALUES ?srUri { ${valuesClause} }
  ?consUri jolux:isMemberOf ?srUri ;
           jolux:dateApplicability ?consDate .
  OPTIONAL {
    ?consUri jolux:isRealizedBy ?exprHtml .
    ?exprHtml jolux:language <${langUri}> ;
              jolux:isEmbodiedBy ?mHtml .
    ?mHtml jolux:format <${HTML_FORMAT}> ;
           jolux:isExemplifiedBy ?htmlUrl .
  }
  OPTIONAL {
    ?consUri jolux:isRealizedBy ?exprPdf .
    ?exprPdf jolux:language <${langUri}> ;
             jolux:isEmbodiedBy ?mPdf .
    ?mPdf jolux:format <${PDF_FORMAT}> ;
          jolux:isExemplifiedBy ?pdfUrl .
  }
}
ORDER BY ?srUri DESC(?consDate)`;

  const result = await sparqlQuery(q);

  // Group by srUri, keep only latest consolidation per law
  const latest = new Map<string, ConsolidationInfo>();
  for (const b of result.results.bindings) {
    const srUri = b.srUri?.value ?? "";
    if (!srUri || latest.has(srUri)) continue; // already have latest (results sorted DESC)
    latest.set(srUri, {
      srUri,
      consolidationUri: b.consUri?.value ?? "",
      consDate:         b.consDate?.value ?? "",
      htmlUrl:          b.htmlUrl?.value ?? "",
      pdfUrl:           b.pdfUrl?.value ?? "",
    });
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Main ingestion
// ---------------------------------------------------------------------------
async function main() {
  const startTime = Date.now();
  console.log(`\n🇨🇭 Fedlex SQLite Ingestion`);
  console.log(`   DB:          ${DB_PATH}`);
  console.log(`   Language:    ${LANG}`);
  console.log(`   Concurrency: ${CONCURRENCY}\n`);

  await mkdir(dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.exec(SCHEMA);

  // Prepared statements
  const insertLaw = db.prepare(`
    INSERT OR REPLACE INTO laws
      (sr_number, eli_uri, title, abbreviation, date_entry_in_force,
       date_no_longer_in_force, is_in_force, latest_consolidation_uri,
       latest_consolidation_date, html_url, pdf_url, law_type, sr_chapter, language, ingested_at)
    VALUES
      (@srNumber, @eliUri, @title, @abbreviation, @dateInForce,
       @dateEnd, @isInForce, @consolidationUri, @consDate,
       @htmlUrl, @pdfUrl, @lawType, @srChapter, @lang, @ingestedAt)`);

  const insertProvision = db.prepare(`
    INSERT INTO provisions
      (law_id, sr_number, article_id, article_number, article_title,
       article_text, language, sort_order)
    VALUES
      (@lawId, @srNumber, @articleId, @articleNumber, @articleTitle,
       @articleText, @language, @sortOrder)`);

  const insertDefinition = db.prepare(`
    INSERT INTO definitions
      (law_id, provision_id, sr_number, term, definition, language)
    VALUES
      (@lawId, @provisionId, @srNumber, @term, @definition, @language)`);

  const insertEuRef = db.prepare(`
    INSERT INTO eu_references
      (law_id, provision_id, sr_number, eu_identifier, eu_type, language)
    VALUES
      (@lawId, @provisionId, @srNumber, @euIdentifier, @euType, @language)`);

  const insertCensus = db.prepare(`
    INSERT OR REPLACE INTO sr_census
      (sr_number, eli_uri, title, has_html, has_pdf, is_in_force, status)
    VALUES
      (@srNumber, @eliUri, @title, @hasHtml, @hasPdf, @isInForce, @status)`);

  const getLawId = db.prepare(`SELECT id FROM laws WHERE sr_number = ?`);

  // Step 1: fetch all law metadata
  const allLaws = await fetchAllLaws(LANG);
  const today   = new Date().toISOString();

  // Step 2: fetch consolidations in batches of 80
  console.log(`\n📦 Fetching latest consolidation + download URLs (batch size 80)…`);
  const BATCH = 80;
  const consMap = new Map<string, ConsolidationInfo>();
  for (let i = 0; i < allLaws.length; i += BATCH) {
    const batch = allLaws.slice(i, i + BATCH);
    const uris  = batch.map((l) => l.uri);
    const batchMap = await fetchConsolidations(uris, LANG);
    for (const [k, v] of batchMap) consMap.set(k, v);
    if ((i / BATCH) % 5 === 0) {
      console.log(`  Progress: ${Math.min(i + BATCH, allLaws.length)} / ${allLaws.length}`);
    }
    // Small delay to be polite to Fedlex servers
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`✅ Consolidation data fetched for ${consMap.size} laws.\n`);

  // Step 3: Insert law metadata into DB + build work list
  const toFetch: Array<{ law: LawMeta; cons: ConsolidationInfo; lawId: number }> = [];
  const pdfOnly: LawMeta[] = [];
  const noHtml: LawMeta[]  = [];

  const insertLaws = db.transaction(() => {
    for (const law of allLaws) {
      const cons = consMap.get(law.uri);
      const isInForce = !law.dateEnd || new Date(law.dateEnd) >= new Date();
      insertLaw.run({
        srNumber:         law.srNumber,
        eliUri:           law.uri,
        title:            law.title,
        abbreviation:     law.abbreviation,
        dateInForce:      law.dateInForce || null,
        dateEnd:          law.dateEnd     || null,
        isInForce:        isInForce ? 1 : 0,
        consolidationUri: cons?.consolidationUri || null,
        consDate:         cons?.consDate         || null,
        htmlUrl:          cons?.htmlUrl           || null,
        pdfUrl:           cons?.pdfUrl            || null,
        lawType:          inferLawType(law.title),
        srChapter:        law.srNumber.split(".")[0],
        lang:             LANG,
        ingestedAt:       today,
      });

      const row = getLawId.get(law.srNumber) as { id: number } | undefined;
      const lawId = row?.id;
      if (!lawId) continue;

      const hasHtml = !!(cons?.htmlUrl);
      const hasPdf  = !!(cons?.pdfUrl);
      insertCensus.run({
        srNumber:  law.srNumber,
        eliUri:    law.uri,
        title:     law.title,
        hasHtml:   hasHtml ? 1 : 0,
        hasPdf:    hasPdf  ? 1 : 0,
        isInForce: isInForce ? 1 : 0,
        status:    hasHtml ? "ingestable" : hasPdf ? "pdf-only" : "no-content",
      });

      if (hasHtml && cons) {
        toFetch.push({ law, cons, lawId });
      } else if (hasPdf) {
        pdfOnly.push(law);
      } else {
        noHtml.push(law);
      }
    }
  });

  insertLaws();
  console.log(`📋 SR Census:`);
  console.log(`   Ingestable (HTML):  ${toFetch.length}`);
  console.log(`   PDF-only:           ${pdfOnly.length}`);
  console.log(`   No content:         ${noHtml.length}\n`);

  // Step 4: Fetch HTML + parse + index in parallel
  let ingested   = 0;
  let errors     = 0;
  let provisions = 0;
  let definitions = 0;
  let euRefs     = 0;

  console.log(`📖 Fetching & parsing HTML documents (concurrency ${CONCURRENCY})…`);

  await inBatches(toFetch, CONCURRENCY, async ({ law, cons, lawId }) => {
    try {
      const resp = await fetch(cons.htmlUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();

      const parsed = parseProvisions(html);
      if (parsed.length === 0) {
        errors++;
        return;
      }

      // Combine all text for definition/EU ref extraction
      const allText = parsed.map((p) => p.articleText).join("\n");

      // Write provisions + extract defs/EU refs in a single transaction per law
      db.transaction(() => {
        for (const p of parsed) {
          const { lastInsertRowid } = insertProvision.run({
            lawId,
            srNumber:      law.srNumber,
            articleId:     p.articleId,
            articleNumber: p.articleNumber,
            articleTitle:  p.articleTitle,
            articleText:   p.articleText,
            language:      LANG,
            sortOrder:     p.sortOrder,
          });
          const provId = Number(lastInsertRowid);
          provisions++;

          // Per-provision definition extraction
          for (const d of extractDefinitions(p.articleText)) {
            insertDefinition.run({
              lawId,
              provisionId: provId,
              srNumber:    law.srNumber,
              term:        d.term,
              definition:  d.definition,
              language:    LANG,
            });
            definitions++;
          }

          // Per-provision EU ref extraction
          for (const r of extractEuRefs(p.articleText)) {
            insertEuRef.run({
              lawId,
              provisionId:  provId,
              srNumber:     law.srNumber,
              euIdentifier: r.euIdentifier,
              euType:       r.euType,
              language:     LANG,
            });
            euRefs++;
          }
        }
      })();

      ingested++;
      if (ingested % 100 === 0) {
        console.log(
          `  [${ingested}/${toFetch.length}] provisions: ${provisions}  defs: ${definitions}  EU refs: ${euRefs}`
        );
      }
    } catch (e) {
      console.error(`  ⚠  ${law.srNumber}: ${(e as Error).message}`);
      errors++;
    }
  });

  // Step 5: Rebuild FTS index (faster than per-row triggers)
  console.log("\n🔍 Building FTS5 index…");
  db.exec("INSERT INTO provisions_fts(provisions_fts) VALUES('rebuild')");
  db.exec("ANALYZE");

  // Step 6: Log ingestion run
  const duration = (Date.now() - startTime) / 1000;
  db.prepare(`
    INSERT INTO ingestion_log
      (run_at, language, laws_total, laws_ingested, laws_pdf_only, laws_error,
       provisions_total, definitions_total, eu_refs_total, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(today, LANG, allLaws.length, ingested, pdfOnly.length, errors,
        provisions, definitions, euRefs, duration);

  db.close();

  // Step 7: Write summary report
  const report = {
    run_at:    today,
    language:  LANG,
    db_path:   DB_PATH,
    stats: {
      laws_total:        allLaws.length,
      laws_ingested:     ingested,
      laws_pdf_only:     pdfOnly.length,
      laws_no_content:   noHtml.length,
      laws_error:        errors,
      provisions_total:  provisions,
      definitions_total: definitions,
      eu_refs_total:     euRefs,
    },
    duration_seconds: Math.round(duration),
  };

  const reportPath = DB_PATH.replace(/\.sqlite$/, "-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n✅ Ingestion complete in ${Math.round(duration)}s`);
  console.log(JSON.stringify(report.stats, null, 2));
  console.log(`\n📊 Report: ${reportPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
