import React from "react";
import {
  Card,
  CardContent,
  Typography,
  FormControlLabel,
  Switch,
  Divider,
  Box,
} from "@mui/material";
import { FiMonitor } from "react-icons/fi";

const DashboardCard = () => {
  const [settings, setSettings] = React.useState(() => {
    const saved = localStorage.getItem("dashboardSettings");

    return (
      saved
        ? JSON.parse(saved)
        : {
            threatMap: true,
            mitre: true,
            liveFeed: true,
            recentCases: true,
            iocStats: true,
          }
    );
  });

  const toggleSetting = (key) => {
    const updated = {
      ...settings,
      [key]: !settings[key],
    };

    setSettings(updated);

    localStorage.setItem(
      "dashboardSettings",
      JSON.stringify(updated)
    );
  };

  const options = [
    {
      key: "threatMap",
      label: "Show Threat Map",
    },
    {
      key: "mitre",
      label: "Show MITRE ATT&CK Matrix",
    },
    {
      key: "liveFeed",
      label: "Show Live Threat Feed",
    },
    {
      key: "recentCases",
      label: "Show Recent Cases",
    },
    {
      key: "iocStats",
      label: "Show IOC Statistics",
    },
  ];

  return (
    <Card
      sx={{
        borderRadius: 3,
        boxShadow: 3,
      }}
    >
      <CardContent>

        <Box
          display="flex"
          alignItems="center"
          gap={1}
          mb={2}
        >
          <FiMonitor size={22} />

          <Typography
            variant="h6"
            fontWeight="bold"
          >
            Dashboard Configuration
          </Typography>
        </Box>

        <Typography
          variant="body2"
          color="text.secondary"
          mb={3}
        >
          Customize which widgets are displayed on your dashboard.
        </Typography>

        {options.map((option, index) => (
          <React.Fragment key={option.key}>

            <FormControlLabel
              control={
                <Switch
                  checked={settings[option.key]}
                  onChange={() =>
                    toggleSetting(option.key)
                  }
                />
              }
              label={option.label}
            />

            {index !== options.length - 1 && (
              <Divider sx={{ my: 1 }} />
            )}

          </React.Fragment>
        ))}

      </CardContent>
    </Card>
  );
};

export default DashboardCard;