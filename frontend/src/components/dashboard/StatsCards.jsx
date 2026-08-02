import React from "react";
import { Grid, Card, Typography, Box } from "@mui/material";
import {
  FiActivity,
  FiAlertTriangle,
  FiCrosshair,
  FiDatabase,
} from "react-icons/fi";

const Stat = ({ label, value, delta, Icon, accent }) => (
  <Card
    className="surface"
    sx={{
      p: 2.3,
      height: "100%",
      borderTop: `2px solid ${accent}`,
    }}
  >
    <Box
      sx={{
        display: "flex",
        justifyContent: "space-between",
        color: "#8290a5",
      }}
    >
      <Typography sx={{ fontSize: 12, fontWeight: 700 }}>
        {label}
      </Typography>

      <Icon size={17} color={accent} />
    </Box>

    <Typography
      sx={{
        mt: 1.7,
        fontSize: 28,
        fontWeight: 800,
        letterSpacing: "-.06em",
      }}
    >
      {value ?? "—"}
    </Typography>

    <Typography
      sx={{
        mt: 0.8,
        fontSize: 11,
        color: "#708098",
      }}
    >
      <span
        style={{
          color: accent,
          fontWeight: 700,
        }}
      >
        {delta}
      </span>{" "}
      since last 24 hours
    </Typography>
  </Card>
);

const StatsCards = ({ values, dashboardSettings }) => {
  return (
    <Grid container spacing={2}>

      <Grid item xs={12} sm={6} md={3}>
        <Stat
          label="Total Signals"
          value={values.totalThreats}
          delta="+12.5%"
          Icon={FiActivity}
          accent="#7688ff"
        />
      </Grid>

      <Grid item xs={12} sm={6} md={3}>
        <Stat
          label="Critical Exposure"
          value={values.critical}
          delta="Needs Attention"
          Icon={FiAlertTriangle}
          accent="#ff6678"
        />
      </Grid>

      <Grid item xs={12} sm={6} md={3}>
        <Stat
          label="High Priority"
          value={values.high}
          delta="+4.2%"
          Icon={FiCrosshair}
          accent="#ffb768"
        />
      </Grid>

      {dashboardSettings.iocStats && (
        <Grid item xs={12} sm={6} md={3}>
          <Stat
            label="Tracked IOCs"
            value={values.iocCount}
            delta="+18 New"
            Icon={FiDatabase}
            accent="#6ee7c7"
          />
        </Grid>
      )}

    </Grid>
  );
};

export default StatsCards;