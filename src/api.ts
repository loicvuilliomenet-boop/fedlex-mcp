/**
 * REST API router — wraps all MCP tools as plain HTTP GET endpoints.
 * Designed for browser/network clients who don't use the MCP SSE transport.
 */
import { Router, Request, Response } from "express";
import {
  searchLegislation,
  listLegislation,
  getLegislation,
  getLegislationText,
  getVersions,
  getCitations,
} from "./tools.js";
import { standardLimiter, heavyLimiter } from "./rateLimiter.js";

const router = Router();

function sendError(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

// GET /api/search?q=Datenschutz&lang=de&limit=20&in_force=true
router.get("/search", standardLimiter, async (req: Request, res: Response) => {
  const { q, lang = "de", limit = "20", in_force = "true" } = req.query as Record<string, string>;
  if (!q) return sendError(res, 400, "Missing required query parameter: q");
  if (!["de", "fr", "it", "rm"].includes(lang)) return sendError(res, 400, "Invalid lang. Use: de, fr, it, rm");
  try {
    const result = await searchLegislation({
      query: q,
      language: lang,
      limit: Math.min(parseInt(limit, 10) || 20, 100),
      in_force_only: in_force !== "false",
    });
    res.json(result);
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
});

// GET /api/list?lang=de&limit=50&offset=0&in_force=true
router.get("/list", standardLimiter, async (req: Request, res: Response) => {
  const { lang = "de", limit = "50", offset = "0", in_force = "true" } = req.query as Record<string, string>;
  if (!["de", "fr", "it", "rm"].includes(lang)) return sendError(res, 400, "Invalid lang");
  try {
    const result = await listLegislation({
      language: lang,
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0,
      in_force_only: in_force !== "false",
    });
    res.json(result);
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
});

// GET /api/legislation/:id?lang=de    (id = SR number or ELI URI segment)
router.get("/legislation/:id(*)", standardLimiter, async (req: Request, res: Response) => {
  const { lang = "de" } = req.query as Record<string, string>;
  const identifier = req.params.id;
  if (!["de", "fr", "it", "rm"].includes(lang)) return sendError(res, 400, "Invalid lang");
  try {
    const result = await getLegislation({ identifier, language: lang });
    res.json(result);
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
});

// GET /api/text/:id?lang=de&format=html&version=2024-01-01
router.get("/text/:id(*)", heavyLimiter, async (req: Request, res: Response) => {
  const { lang = "de", format = "html", version } = req.query as Record<string, string>;
  const identifier = req.params.id;
  if (!["de", "fr", "it", "rm"].includes(lang)) return sendError(res, 400, "Invalid lang");
  if (!["html", "xml"].includes(format)) return sendError(res, 400, "Invalid format. Use: html, xml");
  try {
    const result = await getLegislationText({
      identifier,
      language: lang,
      format: format as "html" | "xml",
      version_date: version,
    });
    res.json(result);
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
});

// GET /api/versions/:id
router.get("/versions/:id(*)", standardLimiter, async (req: Request, res: Response) => {
  const identifier = req.params.id;
  try {
    const result = await getVersions({ identifier });
    res.json(result);
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
});

// GET /api/citations/:id?direction=both&lang=de&limit=50
router.get("/citations/:id(*)", standardLimiter, async (req: Request, res: Response) => {
  const { lang = "de", direction = "both", limit = "50" } = req.query as Record<string, string>;
  const identifier = req.params.id;
  if (!["de", "fr", "it", "rm"].includes(lang)) return sendError(res, 400, "Invalid lang");
  if (!["from", "to", "both"].includes(direction)) return sendError(res, 400, "Invalid direction. Use: from, to, both");
  try {
    const result = await getCitations({
      identifier,
      direction: direction as "from" | "to" | "both",
      language: lang,
      limit: Math.min(parseInt(limit, 10) || 50, 200),
    });
    res.json(result);
  } catch (e) {
    sendError(res, 404, (e as Error).message);
  }
});

export default router;
