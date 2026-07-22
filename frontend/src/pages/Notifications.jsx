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
  Chip,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  CircularProgress,
} from "@mui/material";

import {
  FiEye,
  FiEdit2,
  FiTrash2,
  FiPlus,
  FiSearch,
} from "react-icons/fi";

import { notificationService } from "../services/api";

const initialFormState = {
  title: "",
  message: "",
  severity: "Low",
  status: "Unread",
  type: "System",
};

export const Notifications = () => {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [open, setOpen] = useState(false);
  const [viewDialog, setViewDialog] = useState(false);
  const [editDialog, setEditDialog] = useState(false);

  const [selectedNotification, setSelectedNotification] = useState(null);
  const [formData, setFormData] = useState(initialFormState);

  const loadNotifications = async () => {
    try {
      setLoading(true);
      const res = await notificationService.getNotifications();
      setNotifications(res.data?.data || res.data || []);
    } catch (error) {
      console.error("Failed to load notifications:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadNotifications();
  }, []);

  const createNotification = async () => {
    try {
      await notificationService.createNotification(formData);
      setOpen(false);
      setFormData(initialFormState);
      loadNotifications();
    } catch (error) {
      console.error("Failed to create notification:", error);
    }
  };

  const updateNotification = async () => {
    if (!selectedNotification) return;
    try {
      await notificationService.updateNotification(
        selectedNotification.id,
        selectedNotification
      );
      setEditDialog(false);
      setSelectedNotification(null);
      loadNotifications();
    } catch (error) {
      console.error("Failed to update notification:", error);
    }
  };

  const deleteNotification = async (id) => {
    if (!window.confirm("Delete this notification?")) return;

    try {
      await notificationService.deleteNotification(id);
      loadNotifications();
    } catch (error) {
      console.error("Failed to delete notification:", error);
    }
  };

  const filteredNotifications = notifications.filter((notification) => {
    const q = search.toLowerCase();
    return (
      (notification.title || "").toLowerCase().includes(q) ||
      (notification.message || "").toLowerCase().includes(q)
    );
  });

  const unreadCount = notifications.filter((n) => n.status === "Unread").length;
  const criticalCount = notifications.filter((n) => n.severity === "Critical").length;
  
  // Calculate Today's Notifications
  const todayCount = notifications.filter((n) => {
    if (!n.createdAt) return false;
    return new Date(n.createdAt).toDateString() === new Date().toDateString();
  }).length;

  return (
    <Box p={3}>
      <Typography variant="h4" fontWeight="bold" gutterBottom>
        Notifications
      </Typography>

      {/* Summary Cards */}
      <Grid container spacing={3} mb={3}>
        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography variant="h6">Total Notifications</Typography>
              <Typography variant="h3" color="primary">
                {notifications.length}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography variant="h6">Today's Notifications</Typography>
              <Typography variant="h3" color="success.main">
                {todayCount}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography variant="h6">Unread</Typography>
              <Typography variant="h3" color="warning.main">
                {unreadCount}
              </Typography>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card>
            <CardContent>
              <Typography variant="h6">Critical Alerts</Typography>
              <Typography variant="h3" color="error">
                {criticalCount}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Controls Bar */}
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="center"
        mb={3}
      >
        <TextField
          size="small"
          placeholder="Search Notifications..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{
            startAdornment: <FiSearch style={{ marginRight: 8 }} />,
          }}
          sx={{ width: 350 }}
        />

        <Button
          variant="contained"
          startIcon={<FiPlus />}
          onClick={() => setOpen(true)}
        >
          New Notification
        </Button>
      </Box>

      {/* Data Table */}
      <TableContainer component={Paper}>
        {loading ? (
          <Box display="flex" justifyContent="center" p={6}>
            <CircularProgress />
          </Box>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell><b>Title</b></TableCell>
                <TableCell><b>Message</b></TableCell>
                <TableCell><b>Severity</b></TableCell>
                <TableCell><b>Status</b></TableCell>
                <TableCell><b>Type</b></TableCell>
                <TableCell><b>Date</b></TableCell>
                <TableCell align="center"><b>Actions</b></TableCell>
              </TableRow>
            </TableHead>

            <TableBody>
              {filteredNotifications.length ? (
                filteredNotifications.map((notification) => (
                  <TableRow key={notification.id} hover>
                    <TableCell>{notification.title}</TableCell>
                    <TableCell>{notification.message}</TableCell>
                    <TableCell>
                      <Chip
                        label={notification.severity}
                        color={
                          notification.severity === "Critical"
                            ? "error"
                            : notification.severity === "High"
                            ? "warning"
                            : notification.severity === "Medium"
                            ? "info"
                            : "success"
                        }
                      />
                    </TableCell>

                    <TableCell>
                      <Chip
                        label={notification.status}
                        color={
                          notification.status === "Read"
                            ? "success"
                            : "warning"
                        }
                      />
                    </TableCell>

                    <TableCell>{notification.type}</TableCell>

                    <TableCell>
                      {notification.createdAt
                        ? new Date(notification.createdAt).toLocaleString()
                        : "N/A"}
                    </TableCell>

                    <TableCell align="center">
                      <Button
                        size="small"
                        onClick={() => {
                          setSelectedNotification(notification);
                          setViewDialog(true);
                        }}
                      >
                        <FiEye />
                      </Button>

                      <Button
                        size="small"
                        onClick={() => {
                          setSelectedNotification({ ...notification });
                          setEditDialog(true);
                        }}
                      >
                        <FiEdit2 />
                      </Button>

                      <Button
                        size="small"
                        color="error"
                        onClick={() => deleteNotification(notification.id)}
                      >
                        <FiTrash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    No notifications found.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </TableContainer>

      {/* Create Dialog */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Create Notification</DialogTitle>
        <DialogContent>
          <TextField
            margin="dense"
            label="Title"
            fullWidth
            value={formData.title}
            onChange={(e) =>
              setFormData({ ...formData, title: e.target.value })
            }
          />
          <TextField
            margin="dense"
            label="Message"
            multiline
            rows={4}
            fullWidth
            value={formData.message}
            onChange={(e) =>
              setFormData({ ...formData, message: e.target.value })
            }
          />
          <TextField
            margin="dense"
            label="Severity"
            select
            fullWidth
            value={formData.severity}
            onChange={(e) =>
              setFormData({ ...formData, severity: e.target.value })
            }
          >
            <MenuItem value="Low">Low</MenuItem>
            <MenuItem value="Medium">Medium</MenuItem>
            <MenuItem value="High">High</MenuItem>
            <MenuItem value="Critical">Critical</MenuItem>
          </TextField>
          <TextField
            margin="dense"
            label="Type"
            fullWidth
            value={formData.type}
            onChange={(e) =>
              setFormData({ ...formData, type: e.target.value })
            }
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={createNotification}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* View Dialog */}
      <Dialog
        open={viewDialog}
        onClose={() => setViewDialog(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Notification Details</DialogTitle>
        <DialogContent>
          {selectedNotification && (
            <>
              <Typography>
                <b>Title:</b> {selectedNotification.title}
              </Typography>
              <Typography mt={2}>
                <b>Message:</b> {selectedNotification.message}
              </Typography>
              <Typography mt={2}>
                <b>Severity:</b> {selectedNotification.severity}
              </Typography>
              <Typography mt={2}>
                <b>Status:</b> {selectedNotification.status}
              </Typography>
              <Typography mt={2}>
                <b>Type:</b> {selectedNotification.type}
              </Typography>
              <Typography mt={2}>
                <b>Created:</b>{" "}
                {selectedNotification.createdAt
                  ? new Date(selectedNotification.createdAt).toLocaleString()
                  : "N/A"}
              </Typography>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewDialog(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog
        open={editDialog}
        onClose={() => setEditDialog(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Edit Notification</DialogTitle>
        <DialogContent>
          {selectedNotification && (
            <>
              <TextField
                margin="dense"
                label="Title"
                fullWidth
                value={selectedNotification.title || ""}
                onChange={(e) =>
                  setSelectedNotification({
                    ...selectedNotification,
                    title: e.target.value,
                  })
                }
              />
              <TextField
                margin="dense"
                label="Message"
                multiline
                rows={4}
                fullWidth
                value={selectedNotification.message || ""}
                onChange={(e) =>
                  setSelectedNotification({
                    ...selectedNotification,
                    message: e.target.value,
                  })
                }
              />
              <TextField
                margin="dense"
                label="Severity"
                select
                fullWidth
                value={selectedNotification.severity || "Low"}
                onChange={(e) =>
                  setSelectedNotification({
                    ...selectedNotification,
                    severity: e.target.value,
                  })
                }
              >
                <MenuItem value="Low">Low</MenuItem>
                <MenuItem value="Medium">Medium</MenuItem>
                <MenuItem value="High">High</MenuItem>
                <MenuItem value="Critical">Critical</MenuItem>
              </TextField>
              <TextField
                margin="dense"
                label="Status"
                select
                fullWidth
                value={selectedNotification.status || "Unread"}
                onChange={(e) =>
                  setSelectedNotification({
                    ...selectedNotification,
                    status: e.target.value,
                  })
                }
              >
                <MenuItem value="Unread">Unread</MenuItem>
                <MenuItem value="Read">Read</MenuItem>
              </TextField>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={updateNotification}>
            Save Changes
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Notifications;