/**
 * Fedlex drift detector
 *
 * Compares the latest consolidation dates stored in the local SQLite database
 * against the live Fedlex SPARQL endpoint to identify:
 *   - Laws that have been updated since the last ingest
 *   - Newly published laws not yet in the database
 *   - Laws that have been repealed
 *
 * Usage:
 *   npx tsx scripts/drift.ts [--db ./data/fedlex.sqlite] [--lang de] [--json]
 *
 * Exit codes:
 *   0 — no drift (database is current)
 *   1 — drift detected (trigger re-ingest)
 *   2 — error
 */
import Database from "better-sqlite3";
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { sparqlQuery } from "../src/sparql.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(__dir, "../data/fedlex.sqlite");

const args = process.argv.slice(2);
const getArg = (flag: string, fallback: string) =>
  (() => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : fallback; })();

const DB_PATH   = process.env.FEDLEX_DB_PATH ?? getArg("--db", DEFAULT_DB);
const LANG_CODE = getArg("--lang", "fr");
const JSON_OUT  = args.includes("--json");

const LANG_URI: Record<string, string> = {
  de: "http://publications.europa.eu/resource/authority/language/DEU",
  fr: "http://publications.europa.eu/resource/authority/language/FRA",
  it: "http://publications.europa.eu/resource/authority/language/ITA",
};

interface DriftResult {
  checked_at:    string;
  db_path:       string;
  db_laws_count: number;
  live_laws_count: number;
  changed:       Array<{ sr_number: string; db_date: string; live_date: string }>;
  added:         Array<{ sr_number: string; live_date: string }>;
  removed:       Array<{ sr_number: string; db_date: string }>;
  drift_detected: boolean;
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Run 'npm run ingest' first.`);
    process.exit(2);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const now = new Date().toISOString();

  // Load current state from DB
  const dbLaws = db
    .prepare("SELECT sr_number, latest_consolidation_date FROM laws WHERE is_in_force = 1")
    .all() as { sr_number: string; latest_consolidation_date: string | null }[];

  const dbMap = new Map(dbLaws.map((r) => [r.sr_number, r.latest_consolidation_date ?? ""]));
  db.close();

  console.log(`📋 DB has ${dbMap.size} in-force laws`);
  console.log(`🔍 Checking live Fedlex SPARQL for drift…\n`);

  // Query live latest consolidation dates for all laws
  const langUri = LANG_URI[LANG_CODE] ?? LANG_URI["fr"];
  let offset = 0;
  const pageSize = 2000;
  const liveMap = new Map<string, string>();

  while (true) {
    const q = `
PREFIX rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos:  <http://www.w3.org/2004/02/skos/core#>

SELECT ?notation (MAX(?consDate) AS ?latestDate) WHERE {
  ?srUri rdf:type jolux:ConsolidationAbstract ;
         jolux:classifiedByTaxonomyEntry ?entry .
  ?entry skos:notation ?notation .
  ?consUri jolux:isMemberOf ?srUri ;
           jolux:dateApplicability ?consDate .
  ?srUri jolux:dateEntryInForce ?dateInForce .
  FILTER(xsd:date(?dateInForce) <= xsd:date(now()))
  OPTIONAL { ?srUri jolux:dateNoLongerInForce ?dateEnd . }
  FILTER(!bound(?dateEnd) || xsd:date(?dateEnd) >= xsd:date(now()))
}
GROUP BY ?notation
ORDER BY ?notation
LIMIT ${pageSize}
OFFSET ${offset}`;

    const result = await sparqlQuery(q);
    const batch  = result.results.bindings;
    if (batch.length === 0) break;

    for (const b of batch) {
      const sr   = b.notation?.value;
      const date = b.latestDate?.value;
      if (sr && date) liveMap.set(sr, date);
    }

    console.log(`  Fetched ${liveMap.size} live entries so far…`);
    offset += pageSize;
    if (batch.length < pageSize) break;
  }

  console.log(`\n📡 Live Fedlex: ${liveMap.size} in-force laws`);

  // Compute diff
  const changed: DriftResult["changed"] = [];
  const added:   DriftResult["added"]   = [];
  const removed: DriftResult["removed"] = [];

  for (const [sr, liveDate] of liveMap) {
    if (!dbMap.has(sr)) {
      added.push({ sr_number: sr, live_date: liveDate });
    } else if (dbMap.get(sr) !== liveDate) {
      changed.push({ sr_number: sr, db_date: dbMap.get(sr)!, live_date: liveDate });
    }
  }
  for (const [sr, dbDate] of dbMap) {
    if (!liveMap.has(sr)) {
      removed.push({ sr_number: sr, db_date: dbDate });
    }
  }

  const driftDetected = changed.length > 0 || added.length > 0 || removed.length > 0;

  const result: DriftResult = {
    checked_at:      now,
    db_path:         DB_PATH,
    db_laws_count:   dbMap.size,
    live_laws_count: liveMap.size,
    changed,
    added,
    removed,
    drift_detected:  driftDetected,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (!driftDetected) {
      console.log("✅ No drift detected — database is current.");
    } else {
      console.log(`⚠  Drift detected:`);
      console.log(`   Changed: ${changed.length} laws`);
      console.log(`   Added:   ${added.length} new laws`);
      console.log(`   Removed: ${removed.length} repealed laws`);
      if (changed.length > 0) {
        console.log(`\n   Changed SR numbers (first 20):`);
        changed.slice(0, 20).forEach((c) =>
          console.log(`     ${c.sr_number}: ${c.db_date} → ${c.live_date}`)
        );
      }
      if (added.length > 0) {
        console.log(`\n   New laws (first 10):`);
        added.slice(0, 10).forEach((a) =>
          console.log(`     ${a.sr_number} (${a.live_date})`)
        );
      }
    }
  }

  process.exit(driftDetected ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
