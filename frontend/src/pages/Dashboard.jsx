import React, { useEffect, useState } from 'react'
import {
  Box,
  Grid,
  Card,
  Typography,
  CircularProgress,
  Skeleton,
  CardContent,
} from '@mui/material'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { dashboardService } from '../services/api'
import toast from 'react-hot-toast'
import { FiAlertTriangle, FiBarChart2, FiTrendingUp, FiDatabase } from 'react-icons/fi'

const StatCard = ({ title, value, icon: Icon, color }) => (
  <Card
    sx={{
      backgroundColor: '#161b22',
      border: `1px solid rgba(${color.r}, ${color.g}, ${color.b}, 0.2)`,
      p: 2,
    }}
  >
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Box>
        <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.7)', mb: 1 }}>
          {title}
        </Typography>
        <Typography variant="h4" sx={{ color: `rgb(${color.r}, ${color.g}, ${color.b})` }}>
          {value}
        </Typography>
      </Box>
      <Box sx={{ opacity: 0.3, fontSize: '2rem' }}>
        <Icon size={32} />
      </Box>
    </Box>
  </Card>
)

export const Dashboard = () => {
  const [stats, setStats] = useState(null)
  const [charts, setCharts] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [statsRes, chartsRes] = await Promise.all([
          dashboardService.getStats(),
          dashboardService.getCharts(),
        ])
        console.log("Stats API:", JSON.stringify(statsRes.data, null, 2))
console.log("Charts API:", JSON.stringify(chartsRes.data, null, 2))

        setStats(statsRes.data.data)
setCharts(chartsRes.data.data)
      } catch (error) {
        toast.error('Failed to load dashboard data')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  if (loading) {
    return (
      <Box sx={{ p: 3 }}>
        <Grid container spacing={3}>
          {[1, 2, 3, 4].map((i) => (
            <Grid item xs={12} sm={6} md={3} key={i}>
              <Skeleton variant="rectangular" height={120} />
            </Grid>
          ))}
          <Grid item xs={12} md={6}>
            <Skeleton variant="rectangular" height={300} />
          </Grid>
          <Grid item xs={12} md={6}>
            <Skeleton variant="rectangular" height={300} />
          </Grid>
        </Grid>
      </Box>
    )
  }

  const severityColors = {
    Critical: '#f85149',
    High: '#d29922',
    Medium: '#58a6ff',
    Low: '#3fb950',
  }

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h3" sx={{ mb: 3, color: '#58a6ff' }}>
        Dashboard
      </Typography>

      {/* Stats Cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {stats && (
          <>
            <Grid item xs={12} sm={6} md={3}>
              <StatCard
                title="Total Threats"
                value={stats.totalThreats}
                icon={FiAlertTriangle}
                color={{ r: 88, g: 166, b: 255 }}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <StatCard
                title="Critical"
                value={stats.critical}
                icon={FiTrendingUp}
                color={{ r: 248, g: 81, b: 73 }}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <StatCard
                title="High"
                value={stats.high}
                icon={FiBarChart2}
                color={{ r: 210, g: 153, b: 34 }}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <StatCard
                title="IOCs"
                value={stats.iocCount}
                icon={FiDatabase}
                color={{ r: 63, g: 185, b: 80 }}
              />
            </Grid>
          </>
        )}
      </Grid>

      {/* Charts */}
      <Grid container spacing={3}>
        {/* Severity Pie Chart */}
        {charts && (
          <Grid item xs={12} md={6}>
            <Card sx={{ backgroundColor: '#161b22', p: 2 }}>
              <Typography variant="h6" sx={{ mb: 2, color: '#58a6ff' }}>
                Threat Severity Distribution
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={charts.severity}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, value }) => `${name}: ${value}`}
                    outerRadius={80}
                    fill="#58a6ff"
                    dataKey="value"
                  >
                    {charts.severity.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={severityColors[entry.name]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </Card>
          </Grid>
        )}

        {/* Status Bar Chart */}
        {charts && (
          <Grid item xs={12} md={6}>
            <Card sx={{ backgroundColor: '#161b22', p: 2 }}>
              <Typography variant="h6" sx={{ mb: 2, color: '#58a6ff' }}>
                Threat Status Overview
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
               <BarChart data={charts.status}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis dataKey="name" stroke="rgba(255,255,255,0.7)" />
                  <YAxis stroke="rgba(255,255,255,0.7)" />
                  <Tooltip />
                 <Bar dataKey="value" fill="#58a6ff" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Grid>
        )}

        {/* IOC Type Chart */}
        {charts && (
          <Grid item xs={12}>
            <Card sx={{ backgroundColor: '#161b22', p: 2 }}>
              <Typography variant="h6" sx={{ mb: 2, color: '#58a6ff' }}>
                IOC Types
              </Typography>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={charts.iocTypes}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                  <XAxis dataKey="type" stroke="rgba(255,255,255,0.7)" />
                  <YAxis stroke="rgba(255,255,255,0.7)" />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" fill="#1f6feb" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Grid>
        )}
      </Grid>
    </Box>
  )
}
