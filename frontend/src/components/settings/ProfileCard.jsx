import React from "react";
import {
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Avatar,
  Box,
  Divider,
  Chip,
} from "@mui/material";
import { FiSave, FiUser } from "react-icons/fi";
import { useAuth } from "../../hooks/useAuth";

const ProfileCard = () => {
  const { user } = useAuth();

  const [profile, setProfile] = React.useState(() => {
    const saved = localStorage.getItem("profileSettings");

    return (
      saved
        ? JSON.parse(saved)
        : {
            name: user?.name || "",
            email: user?.email || "",
            role: user?.role || "",
          }
    );
  });

  const handleSave = () => {
    localStorage.setItem(
      "profileSettings",
      JSON.stringify(profile)
    );

    alert("Profile saved successfully.");
  };

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
          User Profile
        </Typography>

        <Box
          display="flex"
          justifyContent="center"
          mb={3}
        >
          <Avatar
            sx={{
              width: 90,
              height: 90,
              bgcolor: "#1565c0",
            }}
          >
            <FiUser size={40} />
          </Avatar>
        </Box>

        <TextField
          fullWidth
          label="Full Name"
          margin="normal"
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
          label="Email Address"
          margin="normal"
          value={profile.email}
          onChange={(e) =>
            setProfile({
              ...profile,
              email: e.target.value,
            })
          }
        />

        <Divider sx={{ my: 3 }} />

        <Typography
          variant="body2"
          color="text.secondary"
          mb={1}
        >
          Current Role
        </Typography>

        <Chip
          label={profile.role}
          color="primary"
        />

        <Divider sx={{ my: 3 }} />

        <Typography
          variant="body2"
          color="text.secondary"
          mb={1}
        >
          Last Login
        </Typography>

        <Typography>
          {new Date().toLocaleString()}
        </Typography>

        <Button
          variant="contained"
          fullWidth
          sx={{ mt: 4 }}
          startIcon={<FiSave />}
          onClick={handleSave}
        >
          Save Profile
        </Button>

      </CardContent>
    </Card>
  );
};

export default ProfileCard;