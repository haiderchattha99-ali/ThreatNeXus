const express = require("express");
const cors = require("cors");

const env = require("./config/env");
const requestContext = require("./middleware/requestContext");
const normalizeMulterError = require("./middleware/normalizeMulterError");
const errorHandler = require("./middleware/errorHandler");

const authRoutes = require("./routes/authRoutes");
const profileRoutes = require("./routes/profileRoutes");
const threatRoutes = require("./routes/threatRoutes");
const reportRoutes = require("./routes/reportRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const caseRoutes = require("./routes/caseRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const organizationRoutes = require("./routes/organizationRoutes");
const ownershipRoutes = require("./routes/ownershipRoutes");
const findingOwnershipRoutes = require("./routes/findingOwnershipRoutes");
const findingEnrichmentRoutes = require("./routes/findingEnrichmentRoutes");
const enrichmentBatchRoutes = require("./routes/enrichmentBatchRoutes");
const findingRiskRoutes = require("./routes/findingRiskRoutes");
const findingVulnerabilityRoutes = require("./routes/findingVulnerabilityRoutes");
const vulnerabilityEnrichmentRoutes = require("./routes/vulnerabilityEnrichmentRoutes");
const vulnerabilityEnrichmentBatchRoutes = require("./routes/vulnerabilityEnrichmentBatchRoutes");
const findingTriageRoutes = require("./routes/findingTriageRoutes");
const findingReadRoutes = require("./routes/findingReadRoutes");
const frameworkMappingRoutes = require("./routes/frameworkMappingRoutes");
const attackRoutes = require("./routes/attackRoutes");
const aiAssistanceRoutes = require("./routes/aiAssistanceRoutes");
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
app.use("/api/reports", reportRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/organizations", organizationRoutes);
app.use("/api/ownership", ownershipRoutes);
app.use("/api/findings", findingOwnershipRoutes);
app.use("/api/findings", findingEnrichmentRoutes);
app.use("/api/findings", findingRiskRoutes);
app.use("/api/findings", findingVulnerabilityRoutes);
app.use("/api/findings", findingTriageRoutes);
// Phase 6 read surface. Registered LAST of the /api/findings routers so its
// "/" and "/:id" declarations can never shadow a sibling's "/:id/<sub>" path —
// an Express param segment matches one segment only, so "/:id" cannot swallow
// "/12/triage", but the ordering makes that independent of Express internals.
app.use("/api/findings", findingReadRoutes);
app.use("/api/enrichment", enrichmentBatchRoutes);
app.use("/api/vulnerabilities", vulnerabilityEnrichmentRoutes);
app.use("/api/vulnerability-enrichment", vulnerabilityEnrichmentBatchRoutes);
// Phase 5. Registered AFTER caseRoutes so the two /api/cases routers compose in
// a defined order — caseRoutes owns "/:id" and "/:id/workflow", neither of which
// matches any framework-mapping or AI path, so nothing is shadowed either way.
app.use("/api/cases", frameworkMappingRoutes);
// Phase 6.3. Not under /api/cases: neither endpoint is scoped to a case — one
// serves the pinned MITRE catalogue, the other aggregates across every case in
// scope.
app.use("/api/attack", attackRoutes);
app.use("/api/ai", aiAssistanceRoutes);
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

app.use(normalizeMulterError);
app.use(errorHandler);

module.exports = app;