import React from "react";
import {
  Card,
  CardContent,
  Typography,
  Box,
  Chip,
  LinearProgress,
  Divider,
} from "@mui/material";
import {
  FiServer,
  FiDatabase,
  FiActivity,
  FiCpu,
} from "react-icons/fi";

const services = [
  {
    name: "Backend Server",
    status: "Online",
    color: "success",
    icon: <FiServer size={20} />,
    usage: 92,
  },
  {
    name: "PostgreSQL Database",
    status: "Healthy",
    color: "success",
    icon: <FiDatabase size={20} />,
    usage: 81,
  },
  {
    name: "IOC Enrichment Queue",
    status: "Running",
    color: "success",
    icon: <FiActivity size={20} />,
    usage: 67,
  },
  {
    name: "Threat Intelligence Engine",
    status: "Active",
    color: "success",
    icon: <FiCpu size={20} />,
    usage: 88,
  },
];

const SystemHealthCard = () => {
  return (
    <Card
      sx={{
        borderRadius: 3,
        boxShadow: 3,
      }}
    >
      <CardContent>

        <Typography
          variant="h6"
          fontWeight="bold"
          mb={3}
        >
          System Health
        </Typography>

        {services.map((service, index) => (
          <Box key={service.name} mb={3}>

            <Box
              display="flex"
              justifyContent="space-between"
              alignItems="center"
            >

              <Box
                display="flex"
                alignItems="center"
                gap={1}
              >
                {service.icon}

                <Typography fontWeight={600}>
                  {service.name}
                </Typography>
              </Box>

              <Chip
                label={service.status}
                color={service.color}
                size="small"
              />

            </Box>

            <Typography
              variant="caption"
              color="text.secondary"
            >
              Service Availability
            </Typography>

            <LinearProgress
              variant="determinate"
              value={service.usage}
              sx={{
                mt: 1,
                borderRadius: 2,
                height: 8,
              }}
            />

            {index !== services.length - 1 && (
              <Divider sx={{ mt: 3 }} />
            )}

          </Box>
        ))}

      </CardContent>
    </Card>
  );
};

export default SystemHealthCard;