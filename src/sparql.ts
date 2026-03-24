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
  // skos:notation values are typed literals; use STR() for string comparison.
  // We prefer the most recent ELI URI when multiple exist (e.g. old + new Constitution).
  const query = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT DISTINCT ?uri WHERE {
  ?uri rdf:type jolux:ConsolidationAbstract ;
       jolux:classifiedByTaxonomyEntry ?entry .
  ?entry skos:notation ?notation .
  FILTER(STR(?notation) = "${srNumber}")
  ?uri jolux:dateEntryInForce ?dateInForce .
}
ORDER BY DESC(?dateInForce)
LIMIT 1`;

  const result = await sparqlQuery(query);
  const binding = result.results.bindings[0];
  return binding ? (val(binding, "uri") ?? null) : null;
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
