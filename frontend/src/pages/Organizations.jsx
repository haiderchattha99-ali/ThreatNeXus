import React, { useEffect, useState } from "react";

import {
  Box,
  Typography,
  Grid,
  Card,
  CardContent,
  Button,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@mui/material";

import {
  FiUsers,
  FiPlus,
  FiSearch,
  FiEye,
  FiEdit2,
  FiTrash2,
} from "react-icons/fi";

import { organizationService } from "../services/api";

const Organizations = () => {

  const [organizations, setOrganizations] = useState([]);

  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");

  const [open, setOpen] = useState(false);

  const [viewDialog, setViewDialog] = useState(false);

  const [editDialog, setEditDialog] = useState(false);

  const [selectedOrganization, setSelectedOrganization] = useState(null);

  const [formData, setFormData] = useState({

    name: "",

    industry: "",

    location: "",

    contactPerson: "",

    email: "",

    phone: "",

    securityScore: 100,

    activeThreats: 0,

  });
  const loadOrganizations = async () => {

  try {

    setLoading(true);

    const res = await organizationService.getOrganizations();

    setOrganizations(res.data.data || []);

  } catch (error) {

    console.error(error);

  } finally {

    setLoading(false);

  }

};

useEffect(() => {

  loadOrganizations();

}, []);

const createOrganization = async () => {

  try {

    await organizationService.createOrganization(formData);

    setOpen(false);

    setFormData({

      name: "",

      industry: "",

      location: "",

      contactPerson: "",

      email: "",

      phone: "",

      securityScore: 100,

      activeThreats: 0,

    });

    loadOrganizations();

  } catch (error) {

    console.error(error);

  }

};

const updateOrganization = async () => {

  try {

    await organizationService.updateOrganization(

      selectedOrganization.id,

      selectedOrganization

    );

    setEditDialog(false);

    loadOrganizations();

  } catch (error) {

    console.error(error);

  }

};

const deleteOrganization = async (id) => {

  if (!window.confirm("Delete this organization?")) return;

  try {

    await organizationService.deleteOrganization(id);

    loadOrganizations();

  } catch (error) {

    console.error(error);

  }

};
const filteredOrganizations = organizations.filter((org) =>
  org.name.toLowerCase().includes(search.toLowerCase()) ||
  org.industry.toLowerCase().includes(search.toLowerCase()) ||
  org.location.toLowerCase().includes(search.toLowerCase())
);

const totalOrganizations = organizations.length;

const avgSecurityScore =
  organizations.length > 0
    ? Math.round(
        organizations.reduce(
          (sum, org) => sum + org.securityScore,
          0
        ) / organizations.length
      )
    : 0;

const totalThreats = organizations.reduce(
  (sum, org) => sum + org.activeThreats,
  0
);
return (
  <Box p={3}>

    <Typography variant="h4" fontWeight="bold" mb={3}>
      Organizations
    </Typography>

    <Grid container spacing={3} mb={3}>

      <Grid item xs={12} md={4}>
        <Card>
          <CardContent>
            <Typography variant="h6">Total Organizations</Typography>
            <Typography variant="h3">
              {totalOrganizations}
            </Typography>
          </CardContent>
        </Card>
      </Grid>

      <Grid item xs={12} md={4}>
        <Card>
          <CardContent>
            <Typography variant="h6">Average Security Score</Typography>
            <Typography variant="h3">
              {avgSecurityScore}
            </Typography>
          </CardContent>
        </Card>
      </Grid>

      <Grid item xs={12} md={4}>
        <Card>
          <CardContent>
            <Typography variant="h6">Active Threats</Typography>
            <Typography variant="h3">
              {totalThreats}
            </Typography>
          </CardContent>
        </Card>
      </Grid>

    </Grid>

    <Box
      display="flex"
      justifyContent="space-between"
      alignItems="center"
      mb={3}
    >

      <TextField
        size="small"
        placeholder="Search Organizations..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        InputProps={{
          startAdornment: <FiSearch />,
        }}
      />

      <Button
        variant="contained"
        startIcon={<FiPlus />}
        onClick={() => setOpen(true)}
      >
        Add Organization
      </Button>

    </Box>
    <TableContainer component={Paper}>

  <Table>

    <TableHead>

      <TableRow>

        <TableCell>Name</TableCell>

        <TableCell>Industry</TableCell>

        <TableCell>Location</TableCell>

        <TableCell>Security Score</TableCell>

        <TableCell>Active Threats</TableCell>

        <TableCell align="center">Actions</TableCell>

      </TableRow>

    </TableHead>

    <TableBody>

      {filteredOrganizations.map((org) => (

        <TableRow key={org.id}>

          <TableCell>{org.name}</TableCell>

          <TableCell>{org.industry}</TableCell>

          <TableCell>{org.location}</TableCell>

          <TableCell>{org.securityScore}</TableCell>

          <TableCell>{org.activeThreats}</TableCell>

          <TableCell align="center">

            <Button
              onClick={() => {
                setSelectedOrganization(org);
                setViewDialog(true);
              }}
            >
              <FiEye />
            </Button>

            <Button
              onClick={() => {
                setSelectedOrganization(org);
                setEditDialog(true);
              }}
            >
              <FiEdit2 />
            </Button>

            <Button
              color="error"
              onClick={() => deleteOrganization(org.id)}
            >
              <FiTrash2 />
            </Button>

          </TableCell>

        </TableRow>

      ))}

    </TableBody>

  </Table>

</TableContainer>
<Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>

  <DialogTitle>Add Organization</DialogTitle>

  <DialogContent>

    <TextField
      fullWidth
      margin="normal"
      label="Organization Name"
      value={formData.name}
      onChange={(e) =>
        setFormData({ ...formData, name: e.target.value })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Industry"
      value={formData.industry}
      onChange={(e) =>
        setFormData({ ...formData, industry: e.target.value })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Location"
      value={formData.location}
      onChange={(e) =>
        setFormData({ ...formData, location: e.target.value })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Contact Person"
      value={formData.contactPerson}
      onChange={(e) =>
        setFormData({
          ...formData,
          contactPerson: e.target.value,
        })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Email"
      value={formData.email}
      onChange={(e) =>
        setFormData({ ...formData, email: e.target.value })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Phone"
      value={formData.phone}
      onChange={(e) =>
        setFormData({ ...formData, phone: e.target.value })
      }
    />

  </DialogContent>

  <DialogActions>

    <Button onClick={() => setOpen(false)}>
      Cancel
    </Button>

    <Button
      variant="contained"
      onClick={createOrganization}
    >
      Save
    </Button>

  </DialogActions>

</Dialog>
<Dialog
  open={viewDialog}
  onClose={() => setViewDialog(false)}
  maxWidth="sm"
  fullWidth
>
  <DialogTitle>Organization Details</DialogTitle>

  <DialogContent>
    {selectedOrganization && (
      <Box mt={1}>

        <Typography><strong>Name:</strong> {selectedOrganization.name}</Typography>

        <Typography><strong>Industry:</strong> {selectedOrganization.industry}</Typography>

        <Typography><strong>Location:</strong> {selectedOrganization.location}</Typography>

        <Typography><strong>Contact Person:</strong> {selectedOrganization.contactPerson}</Typography>

        <Typography><strong>Email:</strong> {selectedOrganization.email}</Typography>

        <Typography><strong>Phone:</strong> {selectedOrganization.phone}</Typography>

        <Typography><strong>Security Score:</strong> {selectedOrganization.securityScore}</Typography>

        <Typography><strong>Active Threats:</strong> {selectedOrganization.activeThreats}</Typography>

      </Box>
    )}
  </DialogContent>

  <DialogActions>
    <Button onClick={() => setViewDialog(false)}>
      Close
    </Button>
  </DialogActions>
</Dialog>
<Dialog
  open={editDialog}
  onClose={() => setEditDialog(false)}
  maxWidth="sm"
  fullWidth
>
  <DialogTitle>Edit Organization</DialogTitle>

  <DialogContent>

    <TextField
      fullWidth
      margin="normal"
      label="Organization Name"
      value={selectedOrganization?.name || ""}
      onChange={(e) =>
        setSelectedOrganization({
          ...selectedOrganization,
          name: e.target.value,
        })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Industry"
      value={selectedOrganization?.industry || ""}
      onChange={(e) =>
        setSelectedOrganization({
          ...selectedOrganization,
          industry: e.target.value,
        })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Location"
      value={selectedOrganization?.location || ""}
      onChange={(e) =>
        setSelectedOrganization({
          ...selectedOrganization,
          location: e.target.value,
        })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Contact Person"
      value={selectedOrganization?.contactPerson || ""}
      onChange={(e) =>
        setSelectedOrganization({
          ...selectedOrganization,
          contactPerson: e.target.value,
        })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Email"
      value={selectedOrganization?.email || ""}
      onChange={(e) =>
        setSelectedOrganization({
          ...selectedOrganization,
          email: e.target.value,
        })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      label="Phone"
      value={selectedOrganization?.phone || ""}
      onChange={(e) =>
        setSelectedOrganization({
          ...selectedOrganization,
          phone: e.target.value,
        })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      type="number"
      label="Security Score"
      value={selectedOrganization?.securityScore || 0}
      onChange={(e) =>
        setSelectedOrganization({
          ...selectedOrganization,
          securityScore: Number(e.target.value),
        })
      }
    />

    <TextField
      fullWidth
      margin="normal"
      type="number"
      label="Active Threats"
      value={selectedOrganization?.activeThreats || 0}
      onChange={(e) =>
        setSelectedOrganization({
          ...selectedOrganization,
          activeThreats: Number(e.target.value),
        })
      }
    />

  </DialogContent>

  <DialogActions>

    <Button onClick={() => setEditDialog(false)}>
      Cancel
    </Button>

    <Button
      variant="contained"
      onClick={updateOrganization}
    >
      Update
    </Button>

  </DialogActions>
</Dialog>
  </Box>
);

};

export default Organizations;