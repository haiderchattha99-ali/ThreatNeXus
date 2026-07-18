const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/authRoutes");
const profileRoutes = require("./routes/profileRoutes");
const threatRoutes = require("./routes/threatRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/threats", threatRoutes);
app.use("/api/dashboard", dashboardRoutes);
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

module.exports = app;