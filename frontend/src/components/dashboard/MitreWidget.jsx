import React from "react";
import {
  Card,
  CardContent,
  Typography,
  Grid,
  Box,
  LinearProgress,
  Chip,
} from "@mui/material";
import { FiShield } from "react-icons/fi";

const tactics = [
  { name: "Initial Access", status: "covered" },
  { name: "Execution", status: "covered" },
  { name: "Persistence", status: "partial" },
  { name: "Privilege Escalation", status: "review" },
  { name: "Defense Evasion", status: "covered" },
  { name: "Credential Access", status: "covered" },
  { name: "Discovery", status: "partial" },
  { name: "Lateral Movement", status: "none" },
  { name: "Collection", status: "covered" },
  { name: "Command & Control", status: "partial" },
  { name: "Exfiltration", status: "none" },
  { name: "Impact", status: "covered" },
];

const statusColor = {
  covered: "#4CAF50",
  partial: "#FFC107",
  review: "#F44336",
  none: "#455A64",
};

const statusText = {
  covered: "Covered",
  partial: "Partial",
  review: "Review",
  none: "Not Detected",
};

const covered = tactics.filter(t => t.status === "covered").length;
const percentage = Math.round((covered / tactics.length) * 100);

const MitreWidget = () => {
  return (
    <Card className="surface" sx={{ mt: 2 }}>
      <CardContent>

        <Box
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          mb={3}
        >
          <Box display="flex" alignItems="center" gap={1}>
            <FiShield size={22} />

            <Typography variant="h6" fontWeight="bold">
              MITRE ATT&CK Coverage
            </Typography>
          </Box>

          <Chip
            label={`${percentage}% Coverage`}
            color="success"
          />
        </Box>

        <LinearProgress
          variant="determinate"
          value={percentage}
          sx={{
            height: 10,
            borderRadius: 5,
            mb: 3,
          }}
        />

        <Grid container spacing={2}>

          {tactics.map((item) => (

            <Grid item xs={6} md={3} key={item.name}>

              <Box
                sx={{
                  bgcolor: "#101723",
                  border: `2px solid ${statusColor[item.status]}`,
                  borderRadius: 2,
                  p: 2,
                  textAlign: "center",
                  transition: ".3s",
                  "&:hover": {
                    transform: "translateY(-4px)",
                    boxShadow: 3,
                  },
                }}
              >

                <Typography
                  fontSize={13}
                  fontWeight={700}
                  mb={1}
                >
                  {item.name}
                </Typography>

                <Box
                  sx={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    bgcolor: statusColor[item.status],
                    mx: "auto",
                    mb: 1,
                  }}
                />

                <Typography
                  fontSize={11}
                  color="text.secondary"
                >
                  {statusText[item.status]}
                </Typography>

              </Box>

            </Grid>

          ))}

        </Grid>

        <Box
          mt={4}
          display="flex"
          gap={2}
          flexWrap="wrap"
        >
          <Chip
            label="Covered"
            sx={{ bgcolor: "#4CAF50", color: "white" }}
          />

          <Chip
            label="Partial"
            sx={{ bgcolor: "#FFC107", color: "black" }}
          />

          <Chip
            label="Needs Review"
            sx={{ bgcolor: "#F44336", color: "white" }}
          />

          <Chip
            label="Not Detected"
            sx={{ bgcolor: "#455A64", color: "white" }}
          />
        </Box>

      </CardContent>
    </Card>
  );
};

export default MitreWidget;