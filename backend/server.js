require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const User = require("./models/User");
const { setSocketIO } = require("./realtime");
const { configurePassport, passport } = require("./config/passport");

const { apiLimiter } = require("./middleware/rateLimiter");
const { sanitizeBody } = require("./middleware/sanitize");

const app = express();
const rootDir = path.join(__dirname, "..");

// Required behind reverse proxies (Render, Nginx, etc.) so rate limiting and req.ip work correctly.
app.set("trust proxy", process.env.TRUST_PROXY || 1);

// CSP disabled: single-file SPA relies on inline handlers in app.html; strict CSP breaks onclick / navigation.
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
  })
);

const ALLOWED = (process.env.ALLOWED_ORIGINS || process.env.CLIENT_URL || "http://localhost:5000,http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
configurePassport();
app.use(passport.initialize());

app.use("/api/", apiLimiter);
app.use(sanitizeBody);

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Register all API routes before frontend static so /api/* is never shadowed by files.
app.use("/api/auth", require("./routes/auth"));
app.use("/api/admin", require("./routes/admin"));
app.use("/api/admin", require("./routes/promotionAdmin"));
app.use("/api/supervisor", require("./routes/supervisor"));
app.use("/api/general-supervisor", require("./routes/generalSupervisor"));
app.use("/api/staff", require("./routes/staff"));
app.use("/api/attendance", require("./routes/attendance"));
app.use("/api/leave", require("./routes/leave"));
app.use("/api/pay", require("./routes/pay"));
app.use("/api/uniform", require("./routes/uniform"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/profile", require("./routes/profile"));
app.use("/api/user", require("./routes/profile"));
app.use("/api/contracts", require("./routes/contracts"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/public", require("./routes/public"));
app.use("/api/timetable", require("./routes/timetable"));
app.use("/api/reports", require("./routes/reports"));

app.get("/api/health", (req, res) => res.json({ status: "ok", ts: Date.now() }));

app.use(express.static(path.join(rootDir, "frontend")));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  return res.sendFile(path.join(rootDir, "frontend", "app.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api"))
    return res.status(404).json({ success: false, message: "Route not found." });
  return res.status(404).send("Not found");
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const safe = status < 500 ? err.message : "Internal server error.";
  console.error("GLOBAL ERROR:", err.stack || err.message);
  console.error(`[${status}] ${req.method} ${req.path} — ${err.message}`);
  const payload = { success: false, message: safe, ...(err.code && { code: err.code }) };
  if (process.env.NODE_ENV === "development" && status >= 500) payload.stack = err.stack;
  res.status(status).json(payload);
});

require("./jobs/autoClockOut");
require("./jobs/rollupAttendanceCache");
require("./jobs/attendanceReportCron").scheduleReportCrons();
require("./jobs/attendanceIntegrityCron").scheduleIntegrityCron();

const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/wms_db";

mongoose.connection.on("connected", () => console.log("MongoDB connected (event)"));
mongoose.connection.on("error", (err) => console.error("MongoDB error:", err.message));

mongoose
  .connect(mongoUri, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    console.log("✅  MongoDB connected");
    const PORT = process.env.PORT || 5000;
    const server = http.createServer(app);
    const { Server } = require("socket.io");
    const io = new Server(server, {
      cors: {
        origin: (origin, cb) => {
          if (!origin || ALLOWED.includes(origin)) return cb(null, true);
          return cb(null, false);
        },
        credentials: true,
      },
    });

    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (!token) return next(new Error("Unauthorized"));
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select("role branch_id is_active");
        if (!user?.is_active) return next(new Error("Unauthorized"));
        socket.user = user;
        next();
      } catch (e) {
        next(new Error("Unauthorized"));
      }
    });

    io.on("connection", (socket) => {
      if (socket.user.role === "admin") socket.join("admins");
      if (socket.user.role === "general_supervisor") socket.join("general_supervisors");
      socket.join(`user:${socket.user._id.toString()}`);
      if (socket.user.branch_id) socket.join(`branch:${socket.user.branch_id.toString()}`);
    });

    setSocketIO(io);

    server.listen(PORT, () => {
      console.log(`\n🚀  YPPEOPLE WMS  →  http://localhost:${PORT}`);
      console.log(`📱  App            →  http://localhost:${PORT}/`);
      console.log(`🔌  Realtime       →  Socket.IO (attendance:changed)`);
    });
  })
  .catch((err) => {
    console.error("❌  MongoDB failed:", err.message);
    process.exit(1);
  });
