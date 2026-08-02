import React from "react";
import {
  Card,
  Typography,
} from "@mui/material";

import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const COLORS = [
  "#ff6678",
  "#ffb768",
  "#7688ff",
  "#6ee7c7",
];

const ThreatSeverityChart = ({ severity, totalThreats }) => {
  return (
    <Card
      className="surface"
      sx={{
        p: { xs: 2, md: 2.5 },
        height: 365,
      }}
    >
      <Typography
        sx={{
          fontWeight: 800,
        }}
      >
        Threat Severity
      </Typography>

      <Typography
        sx={{
          fontSize: 12,
          color: "#75849a",
          mt: 0.5,
        }}
      >
        Active signals by urgency level
      </Typography>

      <ResponsiveContainer
        width="100%"
        height={270}
      >
        <PieChart>

          <Pie
            data={severity}
            innerRadius={70}
            outerRadius={100}
            paddingAngle={5}
            dataKey="value"
          >
            {severity.map((entry, index) => (
              <Cell
                key={index}
                fill={COLORS[index]}
              />
            ))}
          </Pie>

          <Tooltip
            contentStyle={{
              background: "#101723",
              border: "1px solid #2b3a4f",
              borderRadius: 10,
            }}
          />

          <text
            x="50%"
            y="48%"
            textAnchor="middle"
            fill="#eef4ff"
            fontSize="25"
            fontWeight="800"
          >
            {totalThreats}
          </text>

          <text
            x="50%"
            y="56%"
            textAnchor="middle"
            fill="#75849a"
            fontSize="10"
          >
            SIGNALS
          </text>

        </PieChart>
      </ResponsiveContainer>

    </Card>
  );
};

export default ThreatSeverityChart;