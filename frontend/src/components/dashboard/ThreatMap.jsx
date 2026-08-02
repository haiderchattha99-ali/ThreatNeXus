import React from "react";
import {
  Card,
  CardContent,
  Typography,
} from "@mui/material";

import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
} from "react-leaflet";

import L from "leaflet";

import {
  FiGlobe,
} from "react-icons/fi";

delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const threats = [
  {
    country: "Pakistan",
    position: [30.3753, 69.3451],
    severity: "Critical",
  },
  {
    country: "United States",
    position: [37.0902, -95.7129],
    severity: "High",
  },
  {
    country: "Germany",
    position: [51.1657, 10.4515],
    severity: "Medium",
  },
  {
    country: "China",
    position: [35.8617, 104.1954],
    severity: "Low",
  },
];

const ThreatMap = () => {
  return (
    <Card
      className="surface"
      sx={{
        mt: 2,
      }}
    >
      <CardContent>

        <Typography
          variant="h6"
          fontWeight="bold"
        >
          Global Threat Map
        </Typography>

        <Typography
          color="text.secondary"
          mb={2}
        >
          Geographic visualization of detected threats
        </Typography>

        <div
          style={{
            height: "420px",
            borderRadius: "12px",
            overflow: "hidden",
          }}
        >
          <MapContainer
            center={[20, 0]}
            zoom={2}
            style={{
              height: "100%",
              width: "100%",
            }}
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />

            {threats.map((threat) => (
              <Marker
                key={threat.country}
                position={threat.position}
              >
                <Popup>
                  <strong>{threat.country}</strong>
                  <br />
                  Severity: {threat.severity}
                </Popup>
              </Marker>
            ))}

          </MapContainer>
        </div>

      </CardContent>
    </Card>
  );
};

export default ThreatMap;