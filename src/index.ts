#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { fileURLToPath } from "url";
import { join, dirname } from "path";
import { z } from "zod";
import apiRouter from "./api.js";
import { sseLimiter } from "./rateLimiter.js";
import {
  searchLegislation,
  listLegislation,
  getLegislation,
  getLegislationText,
  getVersions,
  getCitations,
} from "./tools.js";
import {
  searchProvisions,
  lookupDefinition,
  findEuReferences,
  getDbStats,
} from "./db-tools.js";

// ---------------------------------------------------------------------------
// Tool registration (shared between stdio and per-connection HTTP servers)
// ---------------------------------------------------------------------------
function registerTools(s: McpServer): void {

s.tool(
  "search_legislation",
  "Search Swiss federal legislation by keyword in titles or abbreviations. " +
    "Returns a list of matching laws with SR numbers, titles, and ELI URIs.",
  {
    query: z.string().describe("Keyword(s) to search for in law titles and abbreviations"),
    language: z
      .enum(["de", "fr", "it", "rm"])
      .optional()
      .default("de")
      .describe("Language for titles: de (German), fr (French), it (Italian), rm (Romansh)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe("Maximum number of results to return (1–100)"),
    in_force_only: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true, only return currently in-force legislation"),
  },
  async (params) => {
    const result = await searchLegislation(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

s.tool(
  "list_legislation",
  "List all Swiss federal legislation (paginated). Useful for browsing the full corpus of laws.",
  {
    language: z
      .enum(["de", "fr", "it", "rm"])
      .optional()
      .default("de")
      .describe("Language for titles"),
    in_force_only: z
      .boolean()
      .optional()
      .default(true)
      .describe("If true, only return currently in-force legislation"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(50)
      .describe("Number of results per page (1–200)"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe("Pagination offset"),
  },
  async (params) => {
    const result = await listLegislation(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

s.tool(
  "get_legislation",
  "Get detailed metadata for a specific Swiss law. " +
    "Pass either an SR number (e.g. '101' for the Federal Constitution, '210' for the Civil Code) " +
    "or a full ELI URI (e.g. 'https://fedlex.data.admin.ch/eli/cc/1999/404'). " +
    "Returns title, dates, latest consolidation info, and download links (PDF, HTML, XML).",
  {
    identifier: z
      .string()
      .describe(
        "SR number (e.g. '101', '220', '311.0') or full ELI URI of the law"
      ),
    language: z
      .enum(["de", "fr", "it", "rm"])
      .optional()
      .default("de")
      .describe("Language for title and abbreviation"),
  },
  async (params) => {
    const result = await getLegislation(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

s.tool(
  "get_legislation_text",
  "Fetch the full text of a Swiss law. " +
    "Returns the complete legal text (plain text extracted from HTML, or raw XML/Akoma Ntoso). " +
    "Pass either an SR number or a full ELI URI. " +
    "Optionally specify a version date to get a historical version.",
  {
    identifier: z
      .string()
      .describe("SR number (e.g. '101') or full ELI URI of the law"),
    language: z
      .enum(["de", "fr", "it", "rm"])
      .optional()
      .default("de")
      .describe("Language of the text to fetch"),
    version_date: z
      .string()
      .optional()
      .describe(
        "ISO date (YYYY-MM-DD) of the consolidation version to fetch. Defaults to the latest version."
      ),
    format: z
      .enum(["html", "xml"])
      .optional()
      .default("html")
      .describe(
        "'html' returns plain text extracted from HTML (easier to read). " +
          "'xml' returns raw Akoma Ntoso XML (available for texts published since 2022)."
      ),
  },
  async (params) => {
    const result = await getLegislationText(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

s.tool(
  "get_versions",
  "Get all historical consolidation versions of a Swiss law. " +
    "Each consolidation corresponds to a specific date on which the law was in effect. " +
    "Use the returned dates with get_legislation_text to fetch a specific version.",
  {
    identifier: z
      .string()
      .describe("SR number (e.g. '101') or full ELI URI of the law"),
  },
  async (params) => {
    const result = await getVersions(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

s.tool(
  "get_citations",
  "Get citation relationships for a Swiss law: which laws cite it, and which laws it cites. " +
    "Useful for understanding the legal context and dependencies of a given act or ordinance.",
  {
    identifier: z
      .string()
      .describe("SR number (e.g. '101') or full ELI URI of the law"),
    direction: z
      .enum(["from", "to", "both"])
      .optional()
      .default("both")
      .describe(
        "'from' = laws that cite this law (cited_by), " +
          "'to' = laws this law cites (cites), " +
          "'both' = all citation relationships"
      ),
    language: z
      .enum(["de", "fr", "it", "rm"])
      .optional()
      .default("de")
      .describe("Language for law titles in results"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(50)
      .describe("Maximum number of citations per direction"),
  },
  async (params) => {
    const result = await getCitations(params);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

  // ---- DB-backed tools (require local SQLite, built by 'npm run ingest') ----

  s.tool(
    "search_provisions",
    "Full-text search across all ~100,000 article provisions in the local Fedlex SQLite database. " +
      "Much faster and more precise than title-only search. " +
      "Requires the database to have been built with 'npm run ingest' or downloaded from releases.",
    {
      query: z.string().describe("Search terms (phrase or keywords)"),
      limit: z.number().int().min(1).max(100).optional().default(20)
        .describe("Maximum results to return"),
      sr_number: z.string().optional()
        .describe("Restrict search to a specific law (SR number, e.g. '311.0')"),
    },
    async (params) => {
      try {
        const result = searchProvisions(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  s.tool(
    "lookup_definition",
    "Search the extracted legal definitions database for a term. " +
      "Returns all places in Swiss federal law where the term is formally defined.",
    {
      term: z.string().describe("Legal term to look up (partial match supported)"),
      limit: z.number().int().min(1).max(50).optional().default(20)
        .describe("Maximum results"),
    },
    async (params) => {
      try {
        const result = lookupDefinition(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  s.tool(
    "find_eu_references",
    "Find Swiss federal laws that implement or reference specific EU directives, regulations, or decisions. " +
      "Pass an EU act identifier (e.g. '2016/679' for GDPR) or filter by type.",
    {
      eu_identifier: z.string().optional()
        .describe("EU act identifier or partial number, e.g. '2016/679', '95/46', '2018/1725'"),
      eu_type: z.enum(["Directive", "Regulation", "Decision", "Unknown"]).optional()
        .describe("Filter by EU act type"),
      limit: z.number().int().min(1).max(100).optional().default(30)
        .describe("Maximum results"),
    },
    async (params) => {
      try {
        const result = findEuReferences(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

  s.tool(
    "get_db_stats",
    "Return statistics about the local Fedlex SQLite database: number of laws, provisions, " +
      "definitions, EU references, database size, and last ingestion timestamp.",
    {},
    async () => {
      try {
        const result = getDbStats();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }
  );

} // end registerTools()

// ---------------------------------------------------------------------------
// Transport: stdio (default) or HTTP (--http flag)
// ---------------------------------------------------------------------------
const useHttp = process.argv.includes("--http");

if (useHttp) {
  // HTTP/SSE transport for online deployment
  const app = express();
  app.use(express.json());

  // Trust proxy headers (needed for correct IP in rate limiting behind reverse proxies)
  app.set("trust proxy", 1);

  // Security headers (CSP, HSTS, X-Frame-Options, etc.)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // inline scripts in index.html
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
      },
    },
  }));

  // CORS: allow all origins for the public API (read-only, no auth)
  app.use("/api", cors({ origin: "*", methods: ["GET"] }));

  // Serve the web client
  const __dir = dirname(fileURLToPath(import.meta.url));
  app.use(express.static(join(__dir, "../public")));

  // REST API
  app.use("/api", apiRouter);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "fedlex-mcp", version: "1.0.0" });
  });

  // MCP SSE transport — one McpServer instance per connection
  const transports = new Map<string, SSEServerTransport>();

  app.get("/sse", sseLimiter, async (req, res) => {
    // Create a fresh McpServer per SSE connection so tool handlers are isolated
    const connServer = new McpServer({
      name: "fedlex-mcp",
      version: "1.0.0",
    });
    registerTools(connServer);

    const transport = new SSEServerTransport("/messages", res);
    transports.set(transport.sessionId, transport);

    res.on("close", () => {
      transports.delete(transport.sessionId);
    });

    await connServer.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  const port = parseInt(process.env.PORT ?? "3000", 10);
  app.listen(port, () => {
    console.error(`fedlex-mcp HTTP server listening on port ${port}`);
    console.error(`  Web client:    http://localhost:${port}/`);
    console.error(`  REST API:      http://localhost:${port}/api/search?q=...`);
    console.error(`  SSE endpoint:  GET  http://localhost:${port}/sse`);
    console.error(`  Message post:  POST http://localhost:${port}/messages`);
    console.error(`  Health check:  GET  http://localhost:${port}/health`);
  });
} else {
  // stdio transport for local Claude Desktop / CLI use
  const server = new McpServer({
    name: "fedlex-mcp",
    version: "1.0.0",
    description:
      "Swiss federal legislation via Fedlex (fedlex.data.admin.ch). " +
      "Access all federal acts, ordinances, and other legal texts in DE/FR/IT/RM.",
  });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("fedlex-mcp stdio server started");
}
