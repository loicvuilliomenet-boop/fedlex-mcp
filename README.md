# fedlex-mcp

MCP server for Swiss federal legislation via [Fedlex](https://fedlex.data.admin.ch).

Provides two complementary layers of access:

- **Live SPARQL tools** — query the Fedlex SPARQL endpoint in real-time (no local setup beyond `npm run build`)
- **SQLite-backed tools** — fast, offline-capable tools that work against a local database built by `npm run ingest`

> Experimental project. Not legal advice. Always verify against the official Fedlex source.

---

## Tools

### Live SPARQL tools

These query `https://fedlex.data.admin.ch/sparqlendpoint` directly and require no local database.

| Tool | Description |
|------|-------------|
| `search_legislation` | Search by keyword in law titles and abbreviations |
| `list_legislation` | List all in-force legislation (paginated) |
| `get_legislation` | Get metadata for a law by SR number or ELI URI |
| `get_legislation_text` | Fetch the full text of a law (HTML or XML) |
| `get_versions` | List all historical consolidation versions |
| `get_citations` | Law-to-law citation graph (which laws cite which) |

### SQLite-backed tools

These work against a local SQLite database built by `npm run ingest`. They are faster, work offline, and provide capabilities not available via SPARQL alone.

| Tool | Description |
|------|-------------|
| `search_provisions` | FTS5 full-text search across all article texts (~100k provisions) |
| `lookup_definition` | Find formal legal definitions by term across all legislation |
| `find_eu_references` | Swiss laws that implement or reference specific EU directives/regulations |
| `get_article_citations` | Article-to-article citation graph (which specific articles cite which) |
| `get_db_stats` | Database statistics: counts, size, and last ingestion timestamp |

> `get_article_citations` is more precise than `get_citations`: instead of "Law A cites Law B", it returns "Art. 12 of the Criminal Code cites Art. 3 of the Data Protection Act".

---

## Identifiers

Every tool that takes an `identifier` accepts either:
- An **SR number** — e.g. `"101"` (Federal Constitution), `"210"` (Civil Code), `"311.0"` (Criminal Code), `"220"` (Code of Obligations)
- A full **ELI URI** — e.g. `"https://fedlex.data.admin.ch/eli/cc/1999/404"`

## Languages

All tools support `language: "fr" | "de" | "it" | "rm"` (default: `"fr"`).

---

## Setup

### 1. Install and build

```bash
npm install && npm run build
```

### 2. (Optional) Build the local SQLite database

Required for the SQLite-backed tools. Downloads and parses all HTML legislation from Fedlex (~7,000 laws, typically 15–30 minutes depending on connection):

```bash
npm run ingest
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--lang` | `fr` | Language to ingest (`de`, `fr`, `it`) |
| `--concurrency` | `5` | Parallel HTML fetches |
| `--db` | `./data/fedlex.sqlite` | Output path for the SQLite file |

You can also set `FEDLEX_DB_PATH` as an environment variable to point the server at an existing database.

The ingestion pipeline:
1. Fetches all `ConsolidationAbstract` entries from SPARQL
2. Resolves the latest consolidation and download URLs per law
3. Fetches and parses HTML documents to extract article provisions
4. Extracts legal definitions and EU cross-references per article
5. Rebuilds the FTS5 full-text index
6. Fetches article-level citation edges from SPARQL and stores them
7. Writes a JSON summary report alongside the database file

---

## Usage

### stdio (local / Claude Desktop)

```bash
node dist/index.js
```

**Claude Desktop config** (`~/.claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "fedlex": {
      "command": "node",
      "args": ["/path/to/fedlex-mcp/dist/index.js"]
    }
  }
}
```

To use a pre-built database, add `FEDLEX_DB_PATH` to the env:
```json
{
  "mcpServers": {
    "fedlex": {
      "command": "node",
      "args": ["/path/to/fedlex-mcp/dist/index.js"],
      "env": { "FEDLEX_DB_PATH": "/path/to/fedlex.sqlite" }
    }
  }
}
```

### HTTP/SSE (online deployment)

```bash
node dist/index.js --http
# custom port:
PORT=8080 node dist/index.js --http
```

MCP endpoints:
- `GET /sse` — SSE stream for MCP clients
- `POST /messages?sessionId=<id>` — message relay

### Docker

```bash
docker build -t fedlex-mcp .
docker run -p 3000:3000 fedlex-mcp
```

### Deploy to Railway / Render / Fly.io

Set the start command to `node dist/index.js --http` and expose port `3000` (or set `PORT` env var).

---

## REST API

All tools are also available as plain HTTP GET endpoints under `/api/`. Useful for browser clients or non-MCP integrations.

### Live SPARQL endpoints

```
GET /api/search?q=<query>&lang=fr&limit=20&in_force=true
GET /api/list?lang=fr&limit=50&offset=0&in_force=true
GET /api/legislation/:id?lang=fr
GET /api/text/:id?lang=fr&format=html&version=2024-01-01
GET /api/versions/:id
GET /api/citations/:id?direction=both&lang=fr&limit=50
```

### SQLite-backed endpoints

```
GET /api/db/search?q=<query>&limit=20&sr=235.1
GET /api/db/definitions?term=<term>&limit=20
GET /api/db/eu-refs?id=2016/679&type=Directive&limit=30
GET /api/db/article-citations?sr=311.0&article=art_1&direction=both&limit=50
GET /api/db/stats
```

Parameters for `/api/db/article-citations`:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sr` | Yes | SR number of the law |
| `article` | No | Filter to a specific article by HTML id (e.g. `art_1`, `art_2a`) |
| `direction` | No | `from` (outgoing), `to` (incoming), or `both` (default) |
| `limit` | No | Max results per direction (default 50, max 200) |

---

## Examples

### Live SPARQL tools

```
search_legislation("protection des données")
→ finds LPD (SR 235.1) and related ordinances

get_legislation("235.1")
→ metadata for the Loi fédérale sur la protection des données

get_legislation_text("311.0", language="fr")
→ full text of the Code pénal suisse

get_versions("220")
→ all historical versions of the Code des obligations

get_citations("101", direction="from", language="fr")
→ all laws that cite the Constitution fédérale

search_legislation("Datenschutz", language="de")
→ same search in German
```

### SQLite-backed tools

```
search_provisions("données personnelles sensibles", sr_number="235.1")
→ FTS5 search within the LPD for that phrase

lookup_definition("personne concernée")
→ all formal definitions of that term across Swiss federal law

find_eu_references(eu_identifier="2016/679")
→ Swiss laws referencing the GDPR

get_article_citations("311.0", article_id="art_12", direction="both")
→ articles that Art. 12 CP cites, and articles in other laws that cite Art. 12 CP

get_db_stats()
→ total counts of laws, provisions, definitions, EU references, article citations
```

---

## Data source

All data comes from the Swiss Federal Chancellery's [Fedlex platform](https://fedlex.data.admin.ch) via:
- **SPARQL endpoint**: `https://fedlex.data.admin.ch/sparqlendpoint`
- **Ontology**: [JOLux](https://swiss.github.io/fedlex-jolux/introduction.html) (based on FRBR, ELI)
- **Formats available**: PDF, HTML, XML (Akoma Ntoso, since 2022), DOCX
- **Coverage**: All Classified Compilation (RS/SR) texts — acts, ordinances, regulations, treaties

---

## Disclaimer

This project is an independent, experimental MCP server for accessing information derived from the Swiss Federal Chancellery's Fedlex platform. It is provided for technical and informational purposes only.

- **No legal advice.** Nothing produced by this project constitutes legal advice, legal opinion, or a substitute for professional counsel.
- **No warranty.** This software is provided **"as is"**, without warranty of any kind. Outputs may be incomplete, inaccurate, unavailable, improperly parsed, or out of date.
- **Verify with official sources.** Users must independently verify all legal texts, references, metadata, and conclusions against the official Fedlex source before relying on them.
- **Use at your own risk.** The author assumes no responsibility or liability for errors, omissions, downtime, misinterpretation of legal materials, or any direct or indirect consequences arising from use of this project.
- **Third-party source dependency.** Availability and correctness depend in part on upstream Fedlex services, data formats, and network conditions, which may change without notice.

By using this project, you accept that it is a best-effort tool and not an authoritative legal system of record.
