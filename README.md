# fedlex-mcp

MCP server for Swiss federal legislation via [Fedlex](https://fedlex.data.admin.ch).

Queries the Fedlex SPARQL endpoint (`https://fedlex.data.admin.ch/sparqlendpoint`) to provide access to all Swiss federal acts, ordinances, and other legal texts in all four national languages (German, French, Italian, Romansh).

> Experimental project. Not legal advice. Always verify against the official Fedlex source.

## Tools

| Tool | Description |
|------|-------------|
| `search_legislation` | Search by keyword in law titles and abbreviations |
| `list_legislation` | List all in-force legislation (paginated) |
| `get_legislation` | Get metadata for a law by SR number or ELI URI |
| `get_legislation_text` | Fetch the full text of a law (HTML or XML) |
| `get_versions` | List all historical consolidation versions |
| `get_citations` | Get citation relationships between laws |

### Identifiers

Every tool that takes an `identifier` accepts either:
- An **SR number** — e.g. `"101"` (Federal Constitution), `"210"` (Civil Code), `"311.0"` (Criminal Code), `"220"` (Code of Obligations)
- A full **ELI URI** — e.g. `"https://fedlex.data.admin.ch/eli/cc/1999/404"`

### Languages

All tools support `language: "de" | "fr" | "it" | "rm"` (default: `"de"`).

## Usage

### stdio (local / Claude Desktop)

```bash
npm install && npm run build
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

### HTTP/SSE (online deployment)

```bash
node dist/index.js --http
# or with a custom port:
PORT=8080 node dist/index.js --http
```

Endpoints:
- `GET /sse` — SSE stream for MCP clients
- `POST /messages?sessionId=<id>` — message endpoint
- `GET /health` — health check

### Docker

```bash
docker build -t fedlex-mcp .
docker run -p 3000:3000 fedlex-mcp
```

### Deploy to Railway / Render / Fly.io

Set the start command to `node dist/index.js --http` and expose port `3000` (or set `PORT` env var).

## Data source

All data comes from the Swiss Federal Chancellery's [Fedlex platform](https://fedlex.data.admin.ch) via:
- **SPARQL endpoint**: `https://fedlex.data.admin.ch/sparqlendpoint`
- **Ontology**: [JOLux](https://swiss.github.io/fedlex-jolux/introduction.html) (based on FRBR, ELI)
- **Formats available**: PDF, HTML, XML (Akoma Ntoso, since 2022), DOCX
- **Coverage**: All Classified Compilation (RS/SR) texts — acts, ordinances, regulations, treaties

## Examples

```
search_legislation("Datenschutz", language="de")
→ finds FADP (Federal Act on Data Protection) and related ordinances

get_legislation("235.1", language="fr")
→ metadata for the LPD (Loi sur la protection des données)

get_legislation_text("311.0", language="de")
→ full text of the Swiss Criminal Code (StGB)

get_versions("220")
→ lists all 80+ historical versions of the Code of Obligations

get_citations("101", direction="from")
→ all currently in-force laws that cite the Federal Constitution
```

## Disclaimer

This project is an independent, experimental MCP server for accessing information derived from the Swiss Federal Chancellery's Fedlex platform. It is provided for technical and informational purposes only.

- **No legal advice.** Nothing produced by this project constitutes legal advice, legal opinion, or a substitute for professional counsel.
- **No warranty.** This software is provided **"as is"**, without warranty of any kind. Outputs may be incomplete, inaccurate, unavailable, improperly parsed, or out of date.
- **Verify with official sources.** Users must independently verify all legal texts, references, metadata, and conclusions against the official Fedlex source before relying on them.
- **Use at your own risk.** The author assumes no responsibility or liability for errors, omissions, downtime, misinterpretation of legal materials, or any direct or indirect consequences arising from use of this project.
- **Third-party source dependency.** Availability and correctness depend in part on upstream Fedlex services, data formats, and network conditions, which may change without notice.

By using this project, you accept that it is a best-effort tool and not an authoritative legal system of record.
