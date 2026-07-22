const express = require("express");
const cors = require("cors");

const env = require("./config/env");
const requestContext = require("./middleware/requestContext");
const errorHandler = require("./middleware/errorHandler");

const authRoutes = require("./routes/authRoutes");
const profileRoutes = require("./routes/profileRoutes");
const threatRoutes = require("./routes/threatRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const caseRoutes = require("./routes/caseRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const organizationRoutes = require("./routes/organizationRoutes");
const app = express();

const allowedOrigins = env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Middlewares
app.use(requestContext);
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header means a non-browser caller (curl, server-to-server) — allow it.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);
app.use(express.json({ limit: env.UPLOAD_MAX_BYTES }));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/threats", threatRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/organizations", organizationRoutes);
// Home Route
app.get("/", (req, res) => {
  res.json({
    project: "ThreatNeXus",
    status: "Backend Running",
    version: "1.0.0",
    time: new Date(),
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use(errorHandler);

module.exports = app;