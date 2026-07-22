import React from "react";
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  Grid,
  Stack,
  Typography,
} from "@mui/material";

import {
  FiArrowLeft,
  FiShield,
  FiMail,
  FiUser,
  FiActivity,
  FiClock,
  FiCheckCircle,
  FiBriefcase,
} from "react-icons/fi";

import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export const Profile = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (!user) {
    return (
      <Box
        sx={{
          height: "100vh",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          bgcolor: "#0F172A",
        }}
      >
        <Typography color="white">
          User not found.
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        bgcolor: "#0F172A",
        minHeight: "100vh",
        p: 4,
      }}
    >
      <Button
        variant="outlined"
        startIcon={<FiArrowLeft />}
        onClick={() => navigate("/dashboard")}
        sx={{
          mb: 3,
          color: "#2563EB",
          borderColor: "#2563EB",
          "&:hover": {
            borderColor: "#3B82F6",
            background: "rgba(37,99,235,.08)",
          },
        }}
      >
        Dashboard
      </Button>

      <Typography
        variant="h4"
        sx={{
          color: "white",
          fontWeight: 700,
          mb: 4,
        }}
      >
        My Profile
      </Typography>

      <Grid container spacing={3}>
        {/* LEFT PANEL */}

        <Grid item xs={12} md={4}>
          <Card
            sx={{
              bgcolor: "#111827",
              border: "1px solid #1E293B",
              borderRadius: 3,
              p: 4,
              textAlign: "center",
            }}
          >
            <Avatar
              sx={{
                width: 130,
                height: 130,
                bgcolor: "#2563EB",
                mx: "auto",
                mb: 3,
                fontSize: 45,
                fontWeight: "bold",
              }}
            >
              {user?.name?.charAt(0)?.toUpperCase()}
            </Avatar>

            <Typography
              variant="h5"
              sx={{
                color: "white",
                fontWeight: 700,
              }}
            >
              {user.name}
            </Typography>

            <Typography
              sx={{
                color: "#94A3B8",
                mt: 1,
              }}
            >
              {user.role}
            </Typography>

            <Chip
              icon={<FiCheckCircle />}
              label="Active Session"
              sx={{
                mt: 3,
                bgcolor: "rgba(34,197,94,.15)",
                color: "#22C55E",
                fontWeight: 600,
              }}
            />

            <Divider
              sx={{
                my: 4,
                borderColor: "#1E293B",
              }}
            />

            <Stack spacing={2}>

              <Box display="flex" alignItems="center">
                <FiShield color="#2563EB" size={18} />
                <Typography
                  sx={{
                    ml: 2,
                    color: "#CBD5E1",
                  }}
                >
                  PKCERT Security Platform
                </Typography>
              </Box>

              <Box display="flex" alignItems="center">
                <FiActivity color="#22C55E" size={18} />
                <Typography
                  sx={{
                    ml: 2,
                    color: "#CBD5E1",
                  }}
                >
                  Backend Connected
                </Typography>
              </Box>

              <Box display="flex" alignItems="center">
                <FiClock color="#F59E0B" size={18} />
                <Typography
                  sx={{
                    ml: 2,
                    color: "#CBD5E1",
                  }}
                >
                  Session Active
                </Typography>
              </Box>

            </Stack>
          </Card>
        </Grid>

        {/* RIGHT PANEL */}

        <Grid item xs={12} md={8}>

          <Card
            sx={{
              bgcolor: "#111827",
              border: "1px solid #1E293B",
              borderRadius: 3,
              p: 4,
              mb: 3,
            }}
          >
            <Typography
              variant="h6"
              sx={{
                color: "white",
                mb: 3,
                fontWeight: 700,
              }}
            >
              Account Information
            </Typography>

            <Grid container spacing={3}>

              <Grid item xs={12} md={6}>
                <Box>

                  <Typography color="#94A3B8">
                    Full Name
                  </Typography>

                  <Stack
                    direction="row"
                    spacing={1}
                    mt={1}
                    alignItems="center"
                  >
                    <FiUser color="#2563EB" />
                    <Typography color="white">
                      {user.name}
                    </Typography>
                  </Stack>

                </Box>
              </Grid>

              <Grid item xs={12} md={6}>
                <Box>

                  <Typography color="#94A3B8">
                    Email
                  </Typography>

                  <Stack
                    direction="row"
                    spacing={1}
                    mt={1}
                    alignItems="center"
                  >
                    <FiMail color="#2563EB" />
                    <Typography color="white">
                      {user.email}
                    </Typography>
                  </Stack>

                </Box>
              </Grid>

              <Grid item xs={12} md={6}>
                <Typography color="#94A3B8">
                  User ID
                </Typography>

                <Typography
                  mt={1}
                  color="white"
                >
                  {user.id}
                </Typography>
              </Grid>

              <Grid item xs={12} md={6}>
                <Typography color="#94A3B8">
                  Role
                </Typography>

                <Stack
                  direction="row"
                  spacing={1}
                  mt={1}
                  alignItems="center"
                >
                  <FiBriefcase color="#2563EB" />
                  <Typography color="white">
                    {user.role}
                  </Typography>
                </Stack>
              </Grid>
                            <Grid item xs={12} md={6}>
                <Typography color="#94A3B8">
                  Department
                </Typography>

                <Typography mt={1} color="white">
                  Threat Intelligence
                </Typography>
              </Grid>

              <Grid item xs={12} md={6}>
                <Typography color="#94A3B8">
                  Account Status
                </Typography>

                <Chip
                  label="Active"
                  size="small"
                  sx={{
                    mt: 1,
                    bgcolor: "rgba(34,197,94,.15)",
                    color: "#22C55E",
                    fontWeight: 600,
                  }}
                />
              </Grid>

            </Grid>
          </Card>

          {/* Security Information */}

          <Card
            sx={{
              bgcolor: "#111827",
              border: "1px solid #1E293B",
              borderRadius: 3,
              p: 4,
              mb: 3,
            }}
          >
            <Typography
              variant="h6"
              sx={{
                color: "white",
                fontWeight: 700,
                mb: 3,
              }}
            >
              Security Information
            </Typography>

            <Grid container spacing={2}>

              {[
                "JWT Authentication",
                "Backend Connected",
                "Role Based Access",
                "Encrypted Session",
              ].map((item) => (
                <Grid item xs={12} sm={6} key={item}>
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      bgcolor: "#0F172A",
                      p: 2,
                      borderRadius: 2,
                    }}
                  >
                    <Typography color="#CBD5E1">
                      {item}
                    </Typography>

                    <Chip
                      label="Enabled"
                      size="small"
                      sx={{
                        bgcolor: "rgba(34,197,94,.15)",
                        color: "#22C55E",
                      }}
                    />
                  </Box>
                </Grid>
              ))}

            </Grid>
          </Card>

          {/* Statistics */}

          <Card
            sx={{
              bgcolor: "#111827",
              border: "1px solid #1E293B",
              borderRadius: 3,
              p: 4,
              mb: 3,
            }}
          >
            <Typography
              variant="h6"
              sx={{
                color: "white",
                fontWeight: 700,
                mb: 3,
              }}
            >
              Analyst Statistics
            </Typography>

            <Grid container spacing={3}>

              {[
                {
                  title: "Threats Reviewed",
                  value: "0",
                },
                {
                  title: "Cases Assigned",
                  value: "0",
                },
                {
                  title: "Reports Uploaded",
                  value: "0",
                },
                {
                  title: "Notifications",
                  value: "0",
                },
              ].map((card) => (
                <Grid item xs={6} md={3} key={card.title}>
                  <Box
                    sx={{
                      textAlign: "center",
                      bgcolor: "#0F172A",
                      borderRadius: 2,
                      p: 3,
                    }}
                  >
                    <Typography
                      variant="h4"
                      sx={{
                        color: "#2563EB",
                        fontWeight: 700,
                      }}
                    >
                      {card.value}
                    </Typography>

                    <Typography
                      sx={{
                        mt: 1,
                        color: "#94A3B8",
                        fontSize: 14,
                      }}
                    >
                      {card.title}
                    </Typography>
                  </Box>
                </Grid>
              ))}

            </Grid>
          </Card>

          {/* About */}

          <Card
            sx={{
              bgcolor: "#111827",
              border: "1px solid #1E293B",
              borderRadius: 3,
              p: 4,
            }}
          >
            <Typography
              variant="h6"
              sx={{
                color: "white",
                mb: 3,
                fontWeight: 700,
              }}
            >
              About ThreatNeXus
            </Typography>

            <Typography
              sx={{
                color: "#CBD5E1",
                lineHeight: 2,
              }}
            >
              ThreatNeXus is an AI-assisted Cyber Threat Intelligence and
              Incident Response Platform developed for PKCERT. It enables
              analysts to collect, correlate, analyze, and respond to
              cybersecurity threats through a centralized dashboard.
            </Typography>

            <Box sx={{ mt: 3 }}>

              <Chip
                label="Threat Intelligence"
                sx={{ mr: 1, mb: 1 }}
                color="primary"
              />

              <Chip
                label="IOC Management"
                sx={{ mr: 1, mb: 1 }}
                color="primary"
              />

              <Chip
                label="Risk Scoring"
                sx={{ mr: 1, mb: 1 }}
                color="primary"
              />

              <Chip
                label="Case Management"
                sx={{ mr: 1, mb: 1 }}
                color="primary"
              />

              <Chip
                label="AI Notifications"
                sx={{ mr: 1, mb: 1 }}
                color="primary"
              />

              <Chip
                label="Reporting"
                sx={{ mr: 1, mb: 1 }}
                color="primary"
              />

            </Box>
          </Card>

        </Grid>
      </Grid>
    </Box>
  );
};