import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  Card,
  Button,
  TextField,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  MenuItem,
} from "@mui/material";

import {
  FiSearch,
  FiRefreshCw,
  FiPlus,
  FiTrash2,
  FiEye,
  FiEdit2,
} from "react-icons/fi";

import { caseService } from "../services/api";
import toast from "react-hot-toast";

const priorityColors = {
  Critical: "#ff6678",
  High: "#ffb768",
  Medium: "#7688ff",
  Low: "#6ee7c7",
};

const statusColors = {
  Open: "#7688ff",
  Investigating: "#ffb768",
  Resolved: "#6ee7c7",
  Closed: "#8491a4",
};

const initialFormState = {
  title: "",
  threatType: "",
  organization: "",
  priority: "Medium",
  status: "Open",
  analyst: "",
  description: "",
};

export const Cases = () => {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);

  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  const [search, setSearch] = useState("");

  const [deleteDialog, setDeleteDialog] = useState({ open: false, item: null });
  const [createDialog, setCreateDialog] = useState(false);
  const [viewDialog, setViewDialog] = useState({ open: false, item: null });
  const [editDialog, setEditDialog] = useState({ open: false, item: null });

  const [formData, setFormData] = useState(initialFormState);

  const fetchCases = async () => {
    try {
      setLoading(true);
      const res = await caseService.getCases();
      setCases(res.data?.data || res.data || []);
    } catch {
      toast.error("Failed to load cases");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCases();
  }, []);

  // Reset pagination page to 0 whenever search changes
  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setPage(0);
  };

  const createCase = async () => {
    try {
      await caseService.createCase(formData);
      toast.success("Case created successfully");
      setCreateDialog(false);
      setFormData(initialFormState);
      fetchCases();
    } catch (err) {
      toast.error("Failed to create case");
    }
  };

  const deleteCase = async () => {
    if (!deleteDialog.item) return;
    try {
      await caseService.deleteCase(deleteDialog.item.id);
      toast.success("Case deleted");
      setDeleteDialog({ open: false, item: null });
      fetchCases();
    } catch (err) {
      toast.error("Delete failed");
    }
  };

  const updateCase = async () => {
    if (!editDialog.item) return;
    try {
      await caseService.updateCase(editDialog.item.id, editDialog.item);
      toast.success("Case updated");
      setEditDialog({ open: false, item: null });
      fetchCases();
    } catch {
      toast.error("Update failed");
    }
  };

  const filteredCases = cases.filter((c) => {
    const q = search.toLowerCase();
    return (
      (c.title || "").toLowerCase().includes(q) ||
      (c.organization || "").toLowerCase().includes(q) ||
      (c.analyst || "").toLowerCase().includes(q) ||
      (c.threatType || "").toLowerCase().includes(q)
    );
  });

  const visibleCases = filteredCases.slice(
    page * rowsPerPage,
    page * rowsPerPage + rowsPerPage
  );

  const openCases = cases.filter((c) => c.status === "Open").length;
  const criticalCases = cases.filter((c) => c.priority === "Critical").length;
  const resolvedCases = cases.filter((c) => c.status === "Resolved").length;

  return (
    <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 1540, mx: "auto" }}>
      {/* Header */}
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 4 }}>
        <Box>
          <Typography className="eyebrow">Intelligence Operations / Cases</Typography>
          <Typography className="page-title" sx={{ mt: 1 }}>Investigation Cases</Typography>
          <Typography sx={{ mt: 1, color: "#91a1b7", fontSize: 13 }}>
            Track investigations and analyst assignments.
          </Typography>
        </Box>

        <Button
          startIcon={<FiRefreshCw />}
          onClick={fetchCases}
          variant="outlined"
          sx={{ borderColor: "#33445c", color: "#b9c6d8" }}
        >
          Refresh
        </Button>
      </Box>

      {/* Metrics */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "repeat(3, 1fr)" },
          gap: 2,
          mb: 3,
        }}
      >
        <Card className="surface" sx={{ p: 3 }}>
          <Typography color="#91a1b7">Open Cases</Typography>
          <Typography sx={{ fontSize: 34, fontWeight: 700 }}>{openCases}</Typography>
        </Card>

        <Card className="surface" sx={{ p: 3 }}>
          <Typography color="#91a1b7">Critical Cases</Typography>
          <Typography sx={{ fontSize: 34, fontWeight: 700, color: "#ff6678" }}>
            {criticalCases}
          </Typography>
        </Card>

        <Card className="surface" sx={{ p: 3 }}>
          <Typography color="#91a1b7">Resolved Cases</Typography>
          <Typography sx={{ fontSize: 34, fontWeight: 700, color: "#6ee7c7" }}>
            {resolvedCases}
          </Typography>
        </Card>
      </Box>

      {/* Search & Actions Bar */}
      <Card
        className="surface"
        sx={{ p: 1.5, mb: 3, display: "flex", gap: 1, alignItems: "center" }}
      >
        <FiSearch color="#7688ff" />
        <TextField
          variant="standard"
          fullWidth
          placeholder="Search title, analyst, organization..."
          value={search}
          onChange={handleSearchChange}
          InputProps={{ disableUnderline: true }}
          sx={{ "& input": { color: "#e7eef9" } }}
        />
        <Button
          startIcon={<FiPlus />}
          variant="contained"
          onClick={() => setCreateDialog(true)}
          sx={{
            bgcolor: "#6ee7c7",
            color: "#091018",
            "&:hover": { bgcolor: "#92f0d5" },
            whiteSpace: "nowrap",
          }}
        >
          New Case
        </Button>
      </Card>

      {/* Cases Table */}
      <TableContainer component={Card} className="surface">
        {loading ? (
          <Box sx={{ p: 8, textAlign: "center" }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>ID</TableCell>
                  <TableCell>Title</TableCell>
                  <TableCell>Organization</TableCell>
                  <TableCell>Priority</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Analyst</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visibleCases.length ? (
                  visibleCases.map((item) => (
                    <TableRow key={item.id} hover>
                      <TableCell>{item.id}</TableCell>
                      <TableCell>{item.title}</TableCell>
                      <TableCell>{item.organization}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={item.priority}
                          sx={{
                            bgcolor: `${priorityColors[item.priority] || "#7688ff"}20`,
                            color: priorityColors[item.priority] || "#7688ff",
                            fontWeight: 700,
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={item.status}
                          sx={{
                            bgcolor: `${statusColors[item.status] || "#8491a4"}20`,
                            color: statusColors[item.status] || "#8491a4",
                            fontWeight: 700,
                          }}
                        />
                      </TableCell>
                      <TableCell>{item.analyst}</TableCell>
                      <TableCell align="right">
                        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1 }}>
                          <Button
                            size="small"
                            startIcon={<FiEye />}
                            sx={{ color: "#6ee7c7" }}
                            onClick={() => setViewDialog({ open: true, item })}
                          >
                            View
                          </Button>
                          <Button
                            size="small"
                            startIcon={<FiEdit2 />}
                            sx={{ color: "#7688ff" }}
                            onClick={() => setEditDialog({ open: true, item: { ...item } })}
                          >
                            Edit
                          </Button>
                          <Button
                            color="error"
                            size="small"
                            startIcon={<FiTrash2 />}
                            onClick={() => setDeleteDialog({ open: true, item })}
                          >
                            Delete
                          </Button>
                        </Box>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} align="center">
                      No Cases Found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>

            <TablePagination
              component="div"
              count={filteredCases.length}
              page={page}
              rowsPerPage={rowsPerPage}
              rowsPerPageOptions={[5, 10, 25]}
              onPageChange={(e, newPage) => setPage(newPage)}
              onRowsPerPageChange={(e) => {
                setRowsPerPage(+e.target.value);
                setPage(0);
              }}
            />
          </>
        )}
      </TableContainer>

      {/* -------------------- DIALOGS -------------------- */}

      {/* 1. Create Case Dialog */}
      <Dialog
        open={createDialog}
        onClose={() => setCreateDialog(false)}
        PaperProps={{
          sx: { bgcolor: "#101723", color: "#fff", minWidth: 500, border: "1px solid #2d3d55" },
        }}
      >
        <DialogTitle>Create Investigation Case</DialogTitle>
        <DialogContent>
          <TextField
            margin="dense"
            fullWidth
            label="Case Title"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          />
          <TextField
            margin="dense"
            fullWidth
            label="Threat Type"
            value={formData.threatType}
            onChange={(e) => setFormData({ ...formData, threatType: e.target.value })}
          />
          <TextField
            margin="dense"
            fullWidth
            label="Organization"
            value={formData.organization}
            onChange={(e) => setFormData({ ...formData, organization: e.target.value })}
          />
          <TextField
            margin="dense"
            fullWidth
            label="Analyst"
            value={formData.analyst}
            onChange={(e) => setFormData({ ...formData, analyst: e.target.value })}
          />
          <TextField
            select
            margin="dense"
            fullWidth
            label="Priority"
            value={formData.priority}
            onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
          >
            <MenuItem value="Critical">Critical</MenuItem>
            <MenuItem value="High">High</MenuItem>
            <MenuItem value="Medium">Medium</MenuItem>
            <MenuItem value="Low">Low</MenuItem>
          </TextField>
          <TextField
            select
            margin="dense"
            fullWidth
            label="Status"
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
          >
            <MenuItem value="Open">Open</MenuItem>
            <MenuItem value="Investigating">Investigating</MenuItem>
            <MenuItem value="Resolved">Resolved</MenuItem>
            <MenuItem value="Closed">Closed</MenuItem>
          </TextField>
          <TextField
            margin="dense"
            fullWidth
            multiline
            rows={4}
            label="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={createCase} sx={{ bgcolor: "#6ee7c7", color: "#091018" }}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* 2. View Case Dialog */}
      <Dialog
        open={viewDialog.open}
        onClose={() => setViewDialog({ open: false, item: null })}
        PaperProps={{
          sx: { bgcolor: "#101723", color: "#fff", minWidth: 550, border: "1px solid #2d3d55" },
        }}
      >
        <DialogTitle>Investigation Details</DialogTitle>
        <DialogContent>
          {viewDialog.item && (
            <Box sx={{ mt: 1 }}>
              <Typography><b>Title:</b> {viewDialog.item.title}</Typography>
              <Typography sx={{ mt: 2 }}><b>Threat:</b> {viewDialog.item.threatType}</Typography>
              <Typography sx={{ mt: 2 }}><b>Organization:</b> {viewDialog.item.organization}</Typography>
              <Typography sx={{ mt: 2 }}><b>Analyst:</b> {viewDialog.item.analyst}</Typography>
              <Typography sx={{ mt: 2 }}><b>Priority:</b> {viewDialog.item.priority}</Typography>
              <Typography sx={{ mt: 2 }}><b>Status:</b> {viewDialog.item.status}</Typography>
              <Typography sx={{ mt: 2 }}><b>Description:</b></Typography>
              <Typography color="#9fb0c5">{viewDialog.item.description || "No description"}</Typography>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewDialog({ open: false, item: null })}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* 3. Edit Case Dialog */}
      <Dialog
        open={editDialog.open}
        onClose={() => setEditDialog({ open: false, item: null })}
        PaperProps={{
          sx: { bgcolor: "#101723", color: "#fff", minWidth: 500, border: "1px solid #2d3d55" },
        }}
      >
        <DialogTitle>Edit Investigation Case</DialogTitle>
        <DialogContent>
          {editDialog.item && (
            <>
              <TextField
                margin="dense"
                fullWidth
                label="Case Title"
                value={editDialog.item.title || ""}
                onChange={(e) =>
                  setEditDialog({
                    ...editDialog,
                    item: { ...editDialog.item, title: e.target.value },
                  })
                }
              />
              <TextField
                margin="dense"
                fullWidth
                label="Threat Type"
                value={editDialog.item.threatType || ""}
                onChange={(e) =>
                  setEditDialog({
                    ...editDialog,
                    item: { ...editDialog.item, threatType: e.target.value },
                  })
                }
              />
              <TextField
                margin="dense"
                fullWidth
                label="Organization"
                value={editDialog.item.organization || ""}
                onChange={(e) =>
                  setEditDialog({
                    ...editDialog,
                    item: { ...editDialog.item, organization: e.target.value },
                  })
                }
              />
              <TextField
                margin="dense"
                fullWidth
                label="Analyst"
                value={editDialog.item.analyst || ""}
                onChange={(e) =>
                  setEditDialog({
                    ...editDialog,
                    item: { ...editDialog.item, analyst: e.target.value },
                  })
                }
              />
              <TextField
                select
                margin="dense"
                fullWidth
                label="Priority"
                value={editDialog.item.priority || "Medium"}
                onChange={(e) =>
                  setEditDialog({
                    ...editDialog,
                    item: { ...editDialog.item, priority: e.target.value },
                  })
                }
              >
                <MenuItem value="Critical">Critical</MenuItem>
                <MenuItem value="High">High</MenuItem>
                <MenuItem value="Medium">Medium</MenuItem>
                <MenuItem value="Low">Low</MenuItem>
              </TextField>
              <TextField
                select
                margin="dense"
                fullWidth
                label="Status"
                value={editDialog.item.status || "Open"}
                onChange={(e) =>
                  setEditDialog({
                    ...editDialog,
                    item: { ...editDialog.item, status: e.target.value },
                  })
                }
              >
                <MenuItem value="Open">Open</MenuItem>
                <MenuItem value="Investigating">Investigating</MenuItem>
                <MenuItem value="Resolved">Resolved</MenuItem>
                <MenuItem value="Closed">Closed</MenuItem>
              </TextField>
              <TextField
                margin="dense"
                fullWidth
                multiline
                rows={4}
                label="Description"
                value={editDialog.item.description || ""}
                onChange={(e) =>
                  setEditDialog({
                    ...editDialog,
                    item: { ...editDialog.item, description: e.target.value },
                  })
                }
              />
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialog({ open: false, item: null })}>Cancel</Button>
          <Button variant="contained" onClick={updateCase} sx={{ bgcolor: "#6ee7c7", color: "#091018" }}>
            Update
          </Button>
        </DialogActions>
      </Dialog>

      {/* 4. Delete Dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false, item: null })}
        PaperProps={{
          sx: { bgcolor: "#101723", color: "#fff", border: "1px solid #2d3d55" },
        }}
      >
        <DialogTitle>Delete Case</DialogTitle>
        <DialogContent>
          Are you sure you want to delete this investigation?
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialog({ open: false, item: null })}>Cancel</Button>
          <Button color="error" variant="contained" onClick={deleteCase}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Cases;