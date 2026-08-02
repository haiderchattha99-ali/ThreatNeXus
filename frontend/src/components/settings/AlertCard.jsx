import React from "react";
import {
  Card,
  CardContent,
  Typography,
  Switch,
  FormControlLabel,
  Divider,
  Box,
} from "@mui/material";
import { FiBell } from "react-icons/fi";

const AlertCard = () => {
  const [alerts, setAlerts] = React.useState(() => {
    const saved = localStorage.getItem("alertSettings");

    return saved
      ? JSON.parse(saved)
      : {
          criticalThreats: true,
          malwareDetection: true,
          iocChanges: true,
          caseAssignment: true,
          feedFailure: true,
          weeklySummary: false,
        };
  });

  const toggle = (key) => {
    const updated = {
      ...alerts,
      [key]: !alerts[key],
    };

    setAlerts(updated);

    localStorage.setItem(
      "alertSettings",
      JSON.stringify(updated)
    );
  };

  const options = [
    {
      key: "criticalThreats",
      label: "Critical Threat Alerts",
    },
    {
      key: "malwareDetection",
      label: "Malware Detection Alerts",
    },
    {
      key: "iocChanges",
      label: "IOC Reputation Changes",
    },
    {
      key: "caseAssignment",
      label: "New Case Assignment",
    },
    {
      key: "feedFailure",
      label: "Threat Feed Failure",
    },
    {
      key: "weeklySummary",
      label: "Weekly Intelligence Summary",
    },
  ];

  return (
    <Card sx={{ borderRadius: 3, boxShadow: 3 }}>
      <CardContent>

        <Box
          display="flex"
          alignItems="center"
          gap={1}
          mb={2}
        >
          <FiBell size={22} />

          <Typography
            variant="h6"
            fontWeight="bold"
          >
            Alert Management
          </Typography>
        </Box>

        <Typography
          variant="body2"
          color="text.secondary"
          mb={3}
        >
          Configure how ThreatNeXus notifies you about
          important security events.
        </Typography>

        {options.map((option, index) => (
          <React.Fragment key={option.key}>

            <FormControlLabel
              control={
                <Switch
                  checked={alerts[option.key]}
                  onChange={() =>
                    toggle(option.key)
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

export default AlertCard;