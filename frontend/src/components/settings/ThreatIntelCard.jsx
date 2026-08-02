import React from "react";
import {
  Card,
  CardContent,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Divider,
  Box,
} from "@mui/material";
import { FiShield } from "react-icons/fi";

const ThreatIntelCard = () => {
  const [settings, setSettings] = React.useState(() => {
    const saved = localStorage.getItem("threatIntelSettings");

    return saved
      ? JSON.parse(saved)
      : {
          refreshInterval: "15 Minutes",
          severity: "High",
          provider: "VirusTotal",
        };
  });

  const updateSetting = (field, value) => {
    const updated = {
      ...settings,
      [field]: value,
    };

    setSettings(updated);

    localStorage.setItem(
      "threatIntelSettings",
      JSON.stringify(updated)
    );
  };

  return (
    <Card sx={{ borderRadius: 3, boxShadow: 3 }}>
      <CardContent>

        <Box display="flex" alignItems="center" gap={1} mb={2}>
          <FiShield size={22} />

          <Typography variant="h6" fontWeight="bold">
            Threat Intelligence
          </Typography>
        </Box>

        <Typography
          variant="body2"
          color="text.secondary"
          mb={3}
        >
          Configure how ThreatNeXus collects and prioritizes
          cyber threat intelligence.
        </Typography>

        <FormControl fullWidth margin="normal">
          <InputLabel>Threat Feed Refresh</InputLabel>

          <Select
            value={settings.refreshInterval}
            label="Threat Feed Refresh"
            onChange={(e) =>
              updateSetting(
                "refreshInterval",
                e.target.value
              )
            }
          >
            <MenuItem value="5 Minutes">
              Every 5 Minutes
            </MenuItem>

            <MenuItem value="15 Minutes">
              Every 15 Minutes
            </MenuItem>

            <MenuItem value="30 Minutes">
              Every 30 Minutes
            </MenuItem>

            <MenuItem value="1 Hour">
              Every Hour
            </MenuItem>
          </Select>
        </FormControl>

        <Divider sx={{ my: 3 }} />

        <FormControl fullWidth margin="normal">
          <InputLabel>Severity Filter</InputLabel>

          <Select
            value={settings.severity}
            label="Severity Filter"
            onChange={(e) =>
              updateSetting(
                "severity",
                e.target.value
              )
            }
          >
            <MenuItem value="Critical">Critical</MenuItem>

            <MenuItem value="High">High</MenuItem>

            <MenuItem value="Medium">Medium</MenuItem>

            <MenuItem value="Low">Low</MenuItem>
          </Select>
        </FormControl>

        <Divider sx={{ my: 3 }} />

        <FormControl fullWidth margin="normal">
          <InputLabel>Default Provider</InputLabel>

          <Select
            value={settings.provider}
            label="Default Provider"
            onChange={(e) =>
              updateSetting(
                "provider",
                e.target.value
              )
            }
          >
            <MenuItem value="VirusTotal">
              VirusTotal
            </MenuItem>

            <MenuItem value="AlienVault OTX">
              AlienVault OTX
            </MenuItem>

            <MenuItem value="MISP">
              MISP
            </MenuItem>

            <MenuItem value="AbuseIPDB">
              AbuseIPDB
            </MenuItem>
          </Select>
        </FormControl>

      </CardContent>
    </Card>
  );
};

export default ThreatIntelCard;