import rateLimit from "express-rate-limit";

/** Standard endpoints: search, list, metadata */
export const standardLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests — please wait a minute before retrying." },
});

/** Heavy endpoints: full text fetch (hits external Fedlex servers) */
export const heavyLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many text-fetch requests — limit is 10 per minute." },
});

/** MCP SSE endpoint: one session per IP at a time is fine, be generous */
export const sseLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many SSE connection attempts." },
});
