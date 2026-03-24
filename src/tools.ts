import {
  sparqlQuery,
  srToUri,
  val,
  langUri,
  stripHtml,
  FILE_TYPE_URIS,
  sparqlEscapeString,
  assertIsoDate,
} from "./sparql.js";

// ---------------------------------------------------------------------------
// Helper: resolve "sr:101" shorthand or full URI
// ---------------------------------------------------------------------------
async function resolveUri(srOrUri: string): Promise<string> {
  if (srOrUri.startsWith("https://") || srOrUri.startsWith("http://")) {
    return srOrUri;
  }
  const uri = await srToUri(srOrUri);
  if (!uri) throw new Error(`No legislation found for SR number "${srOrUri}"`);
  return uri;
}

// ---------------------------------------------------------------------------
// Tool: search_legislation
// ---------------------------------------------------------------------------
export async function searchLegislation(params: {
  query: string;
  language?: string;
  limit?: number;
  in_force_only?: boolean;
}): Promise<object> {
  const lang = params.language ?? "de";
  const limit = Math.min(params.limit ?? 20, 100);
  const inForceOnly = params.in_force_only ?? true;
  // Escape keyword for safe interpolation inside a SPARQL string literal
  const keyword = sparqlEscapeString(params.query.slice(0, 200));

  const inForceFilter = inForceOnly
    ? `
  ?uri jolux:dateEntryInForce ?dateInForce .
  FILTER( xsd:date(?dateInForce) <= xsd:date(now()) )
  OPTIONAL { ?uri jolux:dateNoLongerInForce ?dateEnd . }
  FILTER( !bound(?dateEnd) || xsd:date(?dateEnd) >= xsd:date(now()) )`
    : "";

  const sparql = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT DISTINCT ?uri ?srNumber ?title ?abbreviation WHERE {
  ?uri rdf:type jolux:ConsolidationAbstract ;
       jolux:classifiedByTaxonomyEntry ?entry ;
       jolux:isRealizedBy ?expr .
  ?entry skos:notation ?srNumber .
  ?expr jolux:language <${langUri(lang)}> ;
        jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbreviation . }
  ${inForceFilter}
  FILTER(
    CONTAINS(LCASE(STR(?title)), LCASE("${keyword}"))
    || (bound(?abbreviation) && CONTAINS(LCASE(STR(?abbreviation)), LCASE("${keyword}")))
  )
}
ORDER BY ASC(?srNumber)
LIMIT ${limit}`;

  const result = await sparqlQuery(sparql);
  const items = result.results.bindings.map((b) => ({
    uri: val(b, "uri"),
    sr_number: val(b, "srNumber"),
    title: val(b, "title"),
    abbreviation: val(b, "abbreviation") ?? null,
  }));

  return { count: items.length, language: lang, results: items };
}

// ---------------------------------------------------------------------------
// Tool: list_legislation
// ---------------------------------------------------------------------------
export async function listLegislation(params: {
  language?: string;
  in_force_only?: boolean;
  limit?: number;
  offset?: number;
}): Promise<object> {
  const lang = params.language ?? "de";
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;
  const inForceOnly = params.in_force_only ?? true;

  const inForceFilter = inForceOnly
    ? `
  ?uri jolux:dateEntryInForce ?dateInForce .
  FILTER( xsd:date(?dateInForce) <= xsd:date(now()) )
  OPTIONAL { ?uri jolux:dateNoLongerInForce ?dateEnd . }
  FILTER( !bound(?dateEnd) || xsd:date(?dateEnd) >= xsd:date(now()) )`
    : "";

  const sparql = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT DISTINCT ?uri ?srNumber ?title ?abbreviation WHERE {
  ?uri rdf:type jolux:ConsolidationAbstract ;
       jolux:classifiedByTaxonomyEntry ?entry ;
       jolux:isRealizedBy ?expr .
  ?entry skos:notation ?srNumber .
  ?expr jolux:language <${langUri(lang)}> ;
        jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbreviation . }
  ${inForceFilter}
}
ORDER BY ASC(?srNumber)
LIMIT ${limit}
OFFSET ${offset}`;

  const result = await sparqlQuery(sparql);
  const items = result.results.bindings.map((b) => ({
    uri: val(b, "uri"),
    sr_number: val(b, "srNumber"),
    title: val(b, "title"),
    abbreviation: val(b, "abbreviation") ?? null,
  }));

  return {
    count: items.length,
    offset,
    language: lang,
    in_force_only: inForceOnly,
    results: items,
  };
}

// ---------------------------------------------------------------------------
// Tool: get_legislation
// ---------------------------------------------------------------------------
export async function getLegislation(params: {
  identifier: string;
  language?: string;
}): Promise<object> {
  const lang = params.language ?? "de";
  const uri = await resolveUri(params.identifier);

  const sparql = `
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>

SELECT DISTINCT
  ?srNumber ?title ?abbreviation
  ?dateInForce ?dateEnd
  ?latestConsolidation ?consolidationDate
WHERE {
  <${uri}> jolux:classifiedByTaxonomyEntry ?entry ;
            jolux:isRealizedBy ?expr .
  ?entry skos:notation ?srNumber .
  ?expr jolux:language <${langUri(lang)}> ;
        jolux:title ?title .
  OPTIONAL { ?expr jolux:titleShort ?abbreviation . }
  OPTIONAL { <${uri}> jolux:dateEntryInForce ?dateInForce . }
  OPTIONAL { <${uri}> jolux:dateNoLongerInForce ?dateEnd . }
  OPTIONAL {
    ?latestConsolidation jolux:isMemberOf <${uri}> ;
                         jolux:dateApplicability ?consolidationDate .
  }
}
ORDER BY DESC(?consolidationDate)
LIMIT 1`;

  const result = await sparqlQuery(sparql);
  const b = result.results.bindings[0];
  if (!b) {
    throw new Error(`No legislation found for identifier "${params.identifier}"`);
  }

  // Fetch all available document links for the latest consolidation
  let downloadLinks: object[] = [];
  const consolidationUri = val(b, "latestConsolidation");
  if (consolidationUri) {
    downloadLinks = await getDownloadLinks(consolidationUri, lang);
  }

  return {
    uri,
    sr_number: val(b, "srNumber"),
    title: val(b, "title"),
    abbreviation: val(b, "abbreviation") ?? null,
    date_entry_in_force: val(b, "dateInForce") ?? null,
    date_no_longer_in_force: val(b, "dateEnd") ?? null,
    latest_consolidation: {
      uri: consolidationUri ?? null,
      date: val(b, "consolidationDate") ?? null,
    },
    download_links: downloadLinks,
    language: lang,
    fedlex_url: `https://www.fedlex.admin.ch/eli/cc/${uri.split("/eli/cc/")[1]}/${lang}`,
  };
}

async function getDownloadLinks(
  consolidationUri: string,
  lang: string
): Promise<object[]> {
  const sparql = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>

SELECT DISTINCT ?format ?fileUrl WHERE {
  <${consolidationUri}> jolux:isRealizedBy ?expr .
  ?expr jolux:language <${langUri(lang)}> ;
        jolux:isEmbodiedBy ?manifestation .
  ?manifestation jolux:format ?format ;
                 jolux:isExemplifiedBy ?fileUrl .
}`;

  const result = await sparqlQuery(sparql);
  return result.results.bindings.map((b) => {
    const formatUri = val(b, "format") ?? "";
    let formatName = "unknown";
    if (formatUri.includes("PDF")) formatName = "PDF";
    else if (formatUri.includes("HTML")) formatName = "HTML";
    else if (formatUri.includes("XML")) formatName = "XML";
    else if (formatUri.includes("DOCX")) formatName = "DOCX";
    return { format: formatName, url: val(b, "fileUrl") };
  });
}

// ---------------------------------------------------------------------------
// Tool: get_legislation_text
// ---------------------------------------------------------------------------
export async function getLegislationText(params: {
  identifier: string;
  language?: string;
  version_date?: string;
  format?: "html" | "xml";
}): Promise<object> {
  const lang = params.language ?? "de";
  const preferredFormat = params.format ?? "html";
  const uri = await resolveUri(params.identifier);

  // Find the consolidation (version) to fetch
  let consolidationUri: string | undefined;
  if (params.version_date) {
    const safeDate = assertIsoDate(params.version_date);
    const sparql = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
SELECT ?consolidation WHERE {
  ?consolidation jolux:isMemberOf <${uri}> ;
                 jolux:dateApplicability "${safeDate}"^^<http://www.w3.org/2001/XMLSchema#date> .
}
LIMIT 1`;
    const r = await sparqlQuery(sparql);
    consolidationUri = val(r.results.bindings[0], "consolidation");
  } else {
    // Get the latest consolidation
    const sparql = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
SELECT ?consolidation ?date WHERE {
  ?consolidation jolux:isMemberOf <${uri}> ;
                 jolux:dateApplicability ?date .
}
ORDER BY DESC(?date)
LIMIT 1`;
    const r = await sparqlQuery(sparql);
    consolidationUri = val(r.results.bindings[0], "consolidation");
  }

  if (!consolidationUri) {
    throw new Error(`No consolidation found for "${params.identifier}"`);
  }

  // Get the file URL for the requested format
  const formatUri =
    preferredFormat === "xml"
      ? FILE_TYPE_URIS.XML
      : FILE_TYPE_URIS.HTML;

  const fileSparql = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
SELECT ?fileUrl WHERE {
  <${consolidationUri}> jolux:isRealizedBy ?expr .
  ?expr jolux:language <${langUri(lang)}> ;
        jolux:isEmbodiedBy ?manifestation .
  ?manifestation jolux:format <${formatUri}> ;
                 jolux:isExemplifiedBy ?fileUrl .
}
LIMIT 1`;

  const fileResult = await sparqlQuery(fileSparql);
  let fileUrl = val(fileResult.results.bindings[0], "fileUrl");

  // Fall back to HTML if XML not found
  if (!fileUrl && preferredFormat === "xml") {
    const htmlSparql = fileSparql.replace(formatUri, FILE_TYPE_URIS.HTML);
    const htmlResult = await sparqlQuery(htmlSparql);
    fileUrl = val(htmlResult.results.bindings[0], "fileUrl");
  }

  if (!fileUrl) {
    throw new Error(
      `No ${preferredFormat.toUpperCase()} file found for "${params.identifier}" in language "${lang}"`
    );
  }

  // Fetch and parse the document (10 s timeout to avoid hanging on slow Fedlex servers)
  const response = await fetch(fileUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch document: ${response.status} ${response.statusText}`
    );
  }

  const rawContent = await response.text();
  const text =
    preferredFormat === "xml" && !fileUrl.endsWith(".html")
      ? rawContent
      : stripHtml(rawContent);

  return {
    uri,
    consolidation_uri: consolidationUri,
    file_url: fileUrl,
    language: lang,
    format: preferredFormat,
    text: text.slice(0, 100_000), // cap at 100k chars to avoid overwhelming context
    truncated: text.length > 100_000,
    total_length: text.length,
  };
}

// ---------------------------------------------------------------------------
// Tool: get_versions
// ---------------------------------------------------------------------------
export async function getVersions(params: {
  identifier: string;
}): Promise<object> {
  const uri = await resolveUri(params.identifier);

  const sparql = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
SELECT DISTINCT ?consolidation ?date WHERE {
  ?consolidation jolux:isMemberOf <${uri}> ;
                 jolux:dateApplicability ?date .
}
ORDER BY DESC(?date)`;

  const result = await sparqlQuery(sparql);
  const versions = result.results.bindings.map((b) => ({
    uri: val(b, "consolidation"),
    date: val(b, "date"),
  }));

  return { uri, version_count: versions.length, versions };
}

// ---------------------------------------------------------------------------
// Tool: get_citations
// ---------------------------------------------------------------------------
export async function getCitations(params: {
  identifier: string;
  direction?: "from" | "to" | "both";
  language?: string;
  limit?: number;
}): Promise<object> {
  const lang = params.language ?? "de";
  const direction = params.direction ?? "both";
  const limit = Math.min(params.limit ?? 50, 200);
  const uri = await resolveUri(params.identifier);

  const results: { cited_by: object[]; cites: object[] } = {
    cited_by: [],
    cites: [],
  };

  if (direction === "from" || direction === "both") {
    // Laws that cite this law (cited_by)
    const sparql = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT DISTINCT ?citingLaw ?srNumber ?title ?article WHERE {
  ?subdivision jolux:legalResourceSubdivisionIsPartOf <${uri}> .
  ?citation jolux:citationToLegalResource ?subdivision ;
            jolux:language <${langUri(lang)}> ;
            jolux:citationFromLegalResource/jolux:legalResourceSubdivisionIsPartOf/jolux:isMemberOf ?citingLaw .
  ?citingLaw rdf:type jolux:ConsolidationAbstract ;
             jolux:classifiedByTaxonomyEntry ?entry ;
             jolux:isRealizedBy ?expr .
  ?entry skos:notation ?srNumber .
  ?expr jolux:language <${langUri(lang)}> ;
        jolux:title ?title .
  OPTIONAL { ?citation jolux:descriptionFrom ?article . }
}
ORDER BY ASC(?srNumber)
LIMIT ${limit}`;
    const r = await sparqlQuery(sparql);
    results.cited_by = r.results.bindings.map((b) => ({
      law_uri: val(b, "citingLaw"),
      sr_number: val(b, "srNumber"),
      title: val(b, "title"),
      article: val(b, "article") ?? null,
    }));
  }

  if (direction === "to" || direction === "both") {
    // Laws that this law cites
    const sparql = `
PREFIX jolux: <http://data.legilux.public.lu/resource/ontology/jolux#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>

SELECT DISTINCT ?citedLaw ?srNumber ?title ?article WHERE {
  ?consolidation jolux:isMemberOf <${uri}> .
  ?subdivision jolux:legalResourceSubdivisionIsPartOf ?consolidation .
  ?citation jolux:citationFromLegalResource ?subdivision ;
            jolux:language <${langUri(lang)}> ;
            jolux:citationToLegalResource/jolux:legalResourceSubdivisionIsPartOf ?citedLaw .
  ?citedLaw rdf:type jolux:ConsolidationAbstract ;
            jolux:classifiedByTaxonomyEntry ?entry ;
            jolux:isRealizedBy ?expr .
  ?entry skos:notation ?srNumber .
  ?expr jolux:language <${langUri(lang)}> ;
        jolux:title ?title .
  OPTIONAL { ?citation jolux:descriptionFrom ?article . }
}
ORDER BY ASC(?srNumber)
LIMIT ${limit}`;
    const r = await sparqlQuery(sparql);
    results.cites = r.results.bindings.map((b) => ({
      law_uri: val(b, "citedLaw"),
      sr_number: val(b, "srNumber"),
      title: val(b, "title"),
      article: val(b, "article") ?? null,
    }));
  }

  return { uri, language: lang, ...results };
}
