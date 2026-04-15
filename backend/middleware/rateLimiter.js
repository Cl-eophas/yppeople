const rateLimit = require("express-rate-limit");
const { recordEvent } = require("../utils/intrusion");

const makeLimit = (options) =>
  rateLimit({
    ...options,
    standardHeaders: true,
    legacyHeaders: false,
    handler: async (req, res) => {
      await recordEvent("rate_limit_breach", {
        ip_address: req.ip,
        user_agent: req.headers["user-agent"],
        metadata: { path: req.path, windowMs: options.windowMs, max: options.max },
      });
      res.status(429).json({
        success: false,
        message: options.message || "Too many requests. Please slow down.",
      });
    },
  });

const loginLimiter = makeLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: "Too many login attempts. Wait 1 minute.",
});

const apiLimiter = makeLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
});

const destructiveLimiter = makeLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: "Too many destructive actions. Slow down.",
});

const geoSearchLimiter = makeLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many map searches. Wait a moment.",
});

const exportLimiter = makeLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many export requests. Try again later.",
});

module.exports = { loginLimiter, apiLimiter, destructiveLimiter, geoSearchLimiter, exportLimiter };
