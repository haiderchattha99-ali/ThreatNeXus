import React, { useState } from "react";
import {
  Box,
  Typography,
  Card,
  CardContent,
  Grid,
  TextField,
  Button,
  Divider,
  Switch,
  FormControlLabel,
  Avatar,
} from "@mui/material";
import { FiSettings, FiSave, FiLogOut } from "react-icons/fi";

const Settings = () => {
  const [profile, setProfile] = useState({
    name: "Admin",
    email: "admin@threatnexus.com",
    role: "Administrator",
  });

  const [darkMode, setDarkMode] = useState(true);
  const [notifications, setNotifications] = useState(true);

  return (
    <Box p={3}>
      <Box display="flex" alignItems="center" gap={2} mb={3}>
        <FiSettings size={34} />
        <Typography variant="h4" fontWeight="bold">
          Settings
        </Typography>
      </Box>

      <Grid container spacing={3}>
        {/* Profile */}
        <Grid item xs={12} md={6}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>

              <Typography variant="h6" mb={2}>
                User Profile
              </Typography>

              <Box display="flex" justifyContent="center" mb={3}>
                <Avatar sx={{ width: 80, height: 80 }}>
                  A
                </Avatar>
              </Box>

              <TextField
                fullWidth
                margin="normal"
                label="Name"
                value={profile.name}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    name: e.target.value,
                  })
                }
              />

              <TextField
                fullWidth
                margin="normal"
                label="Email"
                value={profile.email}
                onChange={(e) =>
                  setProfile({
                    ...profile,
                    email: e.target.value,
                  })
                }
              />

              <TextField
                fullWidth
                margin="normal"
                label="Role"
                value={profile.role}
                disabled
              />

              <Button
                variant="contained"
                startIcon={<FiSave />}
                sx={{ mt: 2 }}
              >
                Save Profile
              </Button>

            </CardContent>
          </Card>
        </Grid>

        {/* Preferences */}
        <Grid item xs={12} md={6}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>

              <Typography variant="h6" mb={2}>
                Preferences
              </Typography>

              <FormControlLabel
                control={
                  <Switch
                    checked={darkMode}
                    onChange={() =>
                      setDarkMode(!darkMode)
                    }
                  />
                }
                label="Dark Mode"
              />

              <Divider sx={{ my: 2 }} />

              <FormControlLabel
                control={
                  <Switch
                    checked={notifications}
                    onChange={() =>
                      setNotifications(!notifications)
                    }
                  />
                }
                label="Enable Notifications"
              />

              <Divider sx={{ my: 2 }} />

              <TextField
                fullWidth
                label="API Base URL"
                value="http://localhost:5000/api"
                disabled
              />

            </CardContent>
          </Card>

          <Card sx={{ borderRadius: 3, mt: 3 }}>
            <CardContent>

              <Typography variant="h6">
                About ThreatNeXus
              </Typography>

              <Typography mt={2}>
                ThreatNeXus is an AI-powered Cyber Threat
                Intelligence platform developed for
                Security Operations Centers (SOC).
              </Typography>

              <Typography mt={2}>
                Version 1.0.0
              </Typography>

              <Button
                color="error"
                variant="outlined"
                startIcon={<FiLogOut />}
                sx={{ mt: 3 }}
              >
                Logout
              </Button>

            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
};

export default Settings;