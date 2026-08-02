import React from "react";
import { Box, Typography, Grid } from "@mui/material";
import { FiSettings } from "react-icons/fi";

import ProfileCard from "../components/settings/ProfileCard";
import DashboardCard from "../components/settings/DashboardCard";
import ThreatIntelCard from "../components/settings/ThreatIntelCard";
import AlertCard from "../components/settings/AlertCard";
import SystemHealthCard from "../components/settings/SystemHealthCard";
import AboutCard from "../components/settings/AboutCard";

const Settings = () => {
  return (
    <Box p={3}>

      {/* Header */}

      <Box
        display="flex"
        alignItems="center"
        gap={2}
        mb={4}
      >
        <FiSettings size={34} />

        <Box>
          <Typography
            variant="h4"
            fontWeight="bold"
          >
            Settings
          </Typography>

          <Typography color="text.secondary">
            Configure your ThreatNeXus workspace and
            personal preferences.
          </Typography>
        </Box>
      </Box>

      {/* Cards */}

      <Grid container spacing={3}>

        <Grid item xs={12} md={6}>
          <ProfileCard />
        </Grid>

        <Grid item xs={12} md={6}>
          <DashboardCard />
        </Grid>

        <Grid item xs={12} md={6}>
          <ThreatIntelCard />
        </Grid>

        <Grid item xs={12} md={6}>
          <AlertCard />
        </Grid>

        <Grid item xs={12} md={6}>
          <SystemHealthCard />
        </Grid>

        <Grid item xs={12} md={6}>
          <AboutCard />
        </Grid>

      </Grid>

    </Box>
  );
};

export default Settings;