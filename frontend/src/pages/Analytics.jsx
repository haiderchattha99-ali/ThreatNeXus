import React, { useEffect, useState } from "react";
import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  CircularProgress,
} from "@mui/material";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";

import { Line, Pie, Bar } from "react-chartjs-2";
import axios from "axios";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  BarElement,
  Title,
  Tooltip,
  Legend
);

const Analytics = () => {
  const [threats, setThreats] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadThreats();
  }, []);

  const loadThreats = async () => {
    try {
      const res = await axios.get("http://localhost:5000/api/threats");
      setThreats(res.data?.data || res.data || []);
    } catch (err) {
      console.error("Failed to load threats:", err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        height="70vh"
      >
        <CircularProgress />
      </Box>
    );
  }

  if (threats.length === 0) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        height="70vh"
      >
        <Typography variant="h5">No threat intelligence available</Typography>
      </Box>
    );
  }

  // Calculate severity distributions
  const severityCounts = {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
  };

  // Calculate threat type counts with fallback properties
  const typeCounts = {};

  // Calculate timeline counts based on createdAt
  const timeline = {};

  threats.forEach((t) => {
    if (t.severity && severityCounts[t.severity] !== undefined) {
      severityCounts[t.severity]++;
    }

    const type = t.type || t.threatType || t.category || "Unknown";
    typeCounts[type] = (typeCounts[type] || 0) + 1;

    const day = t.createdAt
      ? new Date(t.createdAt).toLocaleDateString()
      : "Unknown Date";
    timeline[day] = (timeline[day] || 0) + 1;
  });

  // Chart datasets & configuration
  const lineData = {
    labels: Object.keys(timeline),
    datasets: [
      {
        label: "Threats",
        data: Object.values(timeline),
        borderColor: "#4FD1C5",
        backgroundColor: "rgba(79,209,197,.25)",
        fill: true,
        tension: 0.4,
      },
    ],
  };

  const pieData = {
    labels: Object.keys(severityCounts),
    datasets: [
      {
        data: Object.values(severityCounts),
        backgroundColor: [
          "#ef4444",
          "#f59e0b",
          "#3b82f6",
          "#10b981",
        ],
      },
    ],
  };

  const barData = {
    labels: Object.keys(typeCounts),
    datasets: [
      {
        label: "Threat Types",
        data: Object.values(typeCounts),
        backgroundColor: "#6366F1",
      },
    ],
  };

  const commonAnimation = {
    duration: 1500,
  };

  return (
    <Box p={3}>
      <Typography variant="h3" fontWeight="bold" mb={4}>
        Threat Intelligence Analytics
      </Typography>

      {/* KPI Cards */}
      <Grid container spacing={3} mb={4}>
        <Grid item xs={12} sm={6} lg={3}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography color="text.secondary">Total Threats</Typography>
              <Typography variant="h3" fontWeight="bold">
                {threats.length}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={3}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography color="text.secondary">Critical Threats</Typography>
              <Typography
                variant="h3"
                color="error.main"
                fontWeight="bold"
              >
                {severityCounts.Critical}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={3}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography color="text.secondary">High Severity</Typography>
              <Typography
                variant="h3"
                color="warning.main"
                fontWeight="bold"
              >
                {severityCounts.High}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} lg={3}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography color="text.secondary">Medium + Low</Typography>
              <Typography
                variant="h3"
                color="success.main"
                fontWeight="bold"
              >
                {severityCounts.Medium + severityCounts.Low}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Charts Layout */}
      <Grid container spacing={3}>
        <Grid item xs={12} lg={8}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Threat Trend Over Time
              </Typography>
              <Line
                data={lineData}
                options={{
                  responsive: true,
                  animation: commonAnimation,
                }}
              />
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} lg={4}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Severity Distribution
              </Typography>
              <Pie
                data={pieData}
                options={{
                  responsive: true,
                  animation: commonAnimation,
                  plugins: {
                    legend: {
                      position: "bottom",
                    },
                  },
                }}
              />
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Threat Types
              </Typography>
              <Bar
                data={barData}
                options={{
                  responsive: true,
                  animation: commonAnimation,
                  plugins: {
                    legend: {
                      display: false,
                    },
                  },
                  scales: {
                    y: {
                      beginAtZero: true,
                    },
                  },
                }}
              />
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};

export default Analytics;