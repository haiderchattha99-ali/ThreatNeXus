import React from "react";
import { Box, Typography, Chip } from "@mui/material";
import { FiActivity } from "react-icons/fi";

const DashboardHeader = ({ loading }) => {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: { xs: "flex-start", sm: "center" },
        justifyContent: "space-between",
        gap: 2,
        flexDirection: { xs: "column", sm: "row" },
        mb: 3.5,
      }}
    >
      <Box>
        <Typography className="eyebrow">
          Analyst workspace / overview
        </Typography>

        <Typography
          className="page-title"
          sx={{ mt: 0.6 }}
        >
          Security command center
        </Typography>

        <Typography
          sx={{
            mt: 1,
            color: "#8290a5",
            fontSize: 13,
          }}
        >
          Monitor risks, prioritize investigations, and move on
          critical signals.
        </Typography>
      </Box>

      <Chip
        icon={<FiActivity size={14} />}
        label={loading ? "Syncing data" : "Live telemetry"}
        sx={{
          bgcolor: "rgba(110,231,199,.1)",
          color: "#72e5c7",
          border: "1px solid rgba(110,231,199,.2)",
          fontWeight: 700,
          "& .MuiChip-icon": {
            color: "#72e5c7",
          },
        }}
      />
    </Box>
  );
};

export default DashboardHeader;