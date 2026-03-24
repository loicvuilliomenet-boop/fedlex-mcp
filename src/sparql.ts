export const SPARQL_ENDPOINT = "https://fedlex.data.admin.ch/sparqlendpoint";

export const LANGUAGE_URIS: Record<string, string> = {
  de: "http://publications.europa.eu/resource/authority/language/DEU",
  fr: "http://publications.europa.eu/resource/authority/language/FRA",
  it: "http://publications.europa.eu/resource/authority/language/ITA",
  rm: "http://publications.europa.eu/resource/authority/language/ROH",
};

export const FILE_TYPE_URIS = {
  PDF: "http://publications.europa.eu/resource/authority/file-type/PDF",
  HTML: "http://publications.europa.eu/resource/authority/file-type/HTML",
  XML: "http://publications.europa.eu/resource/authority/file-type/XML",
};

export type SparqlBinding = Record<string, { type: string; value: string }>;

export interface SparqlResult {
  head: { vars: string[] };
  results: { bindings: SparqlBinding[] };
}

export async function sparqlQuery(query: string): Promise<SparqlResult> {
  const params = new URLSearchParams({ query, format: "json" });
  const response = await fetch(`${SPARQL_ENDPOINT}?${params}`, {
    headers: { Accept: "application/sparql-results+json" },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `SPARQL query failed (${response.status}): ${text.slice(0, 300)}`
    );
  }

  return response.json() as Promise<SparqlResult>;
}

export function val(
  binding: SparqlBinding,
  key: string
): string | undefined {
  return binding[key]?.value;
}

export function langUri(lang: string): string {
  return LANGUAGE_URIS[lang] ?? LANGUAGE_URIS["de"];
}

/**
 * Resolve a SR number like "101" or "210.10" to its ELI ConsolidationAbstract URI.
 * Returns null if not found.
 */
export async function srToUri(srNumber: string): Promise<string | null> {
  // Validate SR number format (digits and dots only) to prevent SPARQL injection.
  assertSrNumber(srNumber);

  const query = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT DISTINCT ?uri WHERE {
  ?uri rdf:type jolux:ConsolidationAbstract ;
       jolux:classifiedByTaxonomyEntry ?entry .
  ?entry skos:notation ?notation .
  FILTER(STR(?notation) = "${sparqlEscapeString(srNumber)}")
  ?uri jolux:dateEntryInForce ?dateInForce .
}
ORDER BY DESC(?dateInForce)
LIMIT 1`;

  const result = await sparqlQuery(query);
  const binding = result.results.bindings[0];
  return binding ? (val(binding, "uri") ?? null) : null;
}

/** Escape a string for safe interpolation inside a SPARQL string literal */
export function sparqlEscapeString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** Validate that a string is a safe SR number (digits and dots only) */
export function assertSrNumber(s: string): string {
  if (!/^[\d.]+$/.test(s)) throw new Error(`Invalid SR number format: "${s}"`);
  return s;
}

/** Validate an ISO date string YYYY-MM-DD */
export function assertIsoDate(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date format (expected YYYY-MM-DD): "${s}"`);
  return s;
}

/** Strip HTML tags and collapse whitespace */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
