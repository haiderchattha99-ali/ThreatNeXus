import React from "react";
import {
  Card,
  CardContent,
  Typography,
  Box,
  Chip,
  Divider,
  Stack,
} from "@mui/material";
import { FiShield } from "react-icons/fi";

const technologies = [
  "React",
  "Node.js",
  "Express",
  "Prisma",
  "PostgreSQL",
  "JWT",
  "Docker",
];

const AboutCard = () => {
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
          gap={2}
          mb={3}
        >
          <FiShield size={38} color="#1976d2" />

          <Box>
            <Typography variant="h5" fontWeight="bold">
              ThreatNeXus
            </Typography>

            <Typography color="text.secondary">
              AI Powered Cyber Threat Intelligence Platform
            </Typography>
          </Box>
        </Box>

        <Divider sx={{ mb: 3 }} />

        <Typography>
          <strong>Version:</strong> 2.0
        </Typography>

        <Typography>
          <strong>Build:</strong> August 2026
        </Typography>

        <Typography>
          <strong>Environment:</strong> Development
        </Typography>

        <Typography>
          <strong>Database:</strong> PostgreSQL
        </Typography>

        <Typography>
          <strong>Backend:</strong> Node.js + Express
        </Typography>

        <Typography>
          <strong>Frontend:</strong> React + Material UI
        </Typography>

        <Typography>
          <strong>Authentication:</strong> JWT
        </Typography>

        <Typography>
          <strong>AI Engine:</strong> Ready
        </Typography>

        <Divider sx={{ my: 3 }} />

        <Typography
          variant="subtitle1"
          fontWeight="bold"
          gutterBottom
        >
          Technology Stack
        </Typography>

        <Stack
          direction="row"
          spacing={1}
          flexWrap="wrap"
          useFlexGap
        >
          {technologies.map((tech) => (
            <Chip
              key={tech}
              label={tech}
              color="primary"
              variant="outlined"
            />
          ))}
        </Stack>

        <Divider sx={{ my: 3 }} />

        <Typography variant="body2">
          ThreatNeXus is an enterprise Cyber Threat Intelligence
          platform designed for Security Operations Centers (SOC).
          It provides threat ingestion, IOC enrichment, risk
          scoring, vulnerability intelligence, analytics and
          role-based access control in a unified dashboard.
        </Typography>

        <Divider sx={{ my: 3 }} />

        <Typography
          align="center"
          color="text.secondary"
          variant="caption"
        >
          © 2026 ThreatNeXus • PKCERT Academic Project
        </Typography>

      </CardContent>
    </Card>
  );
};

export default AboutCard;