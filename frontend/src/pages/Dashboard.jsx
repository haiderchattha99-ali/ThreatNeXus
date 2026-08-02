import React, { useEffect, useState, useMemo } from 'react'
import DashboardHeader from '../components/dashboard/DashboardHeader'
import ThreatMap from '../components/dashboard/ThreatMap'
import {
  Box,
  Grid,
  Card,
  Typography,
  LinearProgress,
  Chip,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Avatar,
  Paper
} from '@mui/material'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts'
import { dashboardService } from '../services/api'
import toast from 'react-hot-toast'
import {
  FiAlertTriangle,
  FiCrosshair,
  FiDatabase,
  FiArrowUpRight,
  FiActivity,
  FiRefreshCw,
  FiGrid,
  FiServer,
  FiShield,
  FiGlobe,
  FiFileText,
  FiSearch,
  FiPlusCircle,
  FiUploadCloud,
  FiRadio,
  FiTrendingUp,
  FiUsers,
  FiFolder,
  FiClock,
  FiCheckCircle,
  FiAlertCircle
} from 'react-icons/fi'

const COLORS = ['#ff6678', '#ffb768', '#7688ff', '#6ee7c7']
const fallback = { totalThreats: 0, critical: 0, high: 0, iocCount: 0 }

const mitreTactics = [
  { name: 'Initial Access', status: 'Covered', count: '12/12' },
  { name: 'Execution', status: 'Covered', count: '10/10' },
  { name: 'Persistence', status: 'Partial', count: '7/12' },
  { name: 'Privilege Escalation', status: 'Covered', count: '8/8' },
  { name: 'Defense Evasion', status: 'Needs Review', count: '4/15' },
  { name: 'Credential Access', status: 'Covered', count: '9/9' },
  { name: 'Discovery', status: 'Partial', count: '5/10' },
  { name: 'Lateral Movement', status: 'Needs Review', count: '3/11' },
  { name: 'Collection', status: 'Covered', count: '6/6' },
  { name: 'Command & Control', status: 'Covered', count: '14/14' },
  { name: 'Exfiltration', status: 'Not Detected', count: '0/8' },
  { name: 'Impact', status: 'Covered', count: '7/7' }
]

const socHealthServices = [
  { name: 'Backend API', status: 'green', latency: '12ms' },
  { name: 'Database', status: 'green', latency: '4ms' },
  { name: 'IOC Queue', status: 'green', latency: '18ms' },
  { name: 'Risk Engine', status: 'yellow', latency: '142ms' },
  { name: 'Notification Service', status: 'green', latency: '8ms' },
  { name: 'Authentication', status: 'green', latency: '15ms' }
]

const liveThreatFeed = [
  { id: 1, type: 'Malicious IP', value: '185.220.101.5', severity: 'Critical', time: '2m ago' },
  { id: 2, type: 'New Domain', value: 'auth-update-secure.com', severity: 'High', time: '5m ago' },
  { id: 3, type: 'Malware Hash', value: 'e5d7a9b...c182f', severity: 'Critical', time: '12m ago' },
  { id: 4, type: 'Phishing URL', value: 'https://login-verify.net/portal', severity: 'High', time: '18m ago' },
  { id: 5, type: 'CVE Imported', value: 'CVE-2026-1184 (RCE)', severity: 'Medium', time: '25m ago' }
]

const threatTrendData = [
  { day: 'Mon', threats: 142 },
  { day: 'Tue', threats: 189 },
  { day: 'Wed', threats: 165 },
  { day: 'Thu', threats: 230 },
  { day: 'Fri', threats: 210 },
  { day: 'Sat', threats: 175 },
  { day: 'Sun', threats: 248 }
]

const topThreatCountries = [
  { country: 'Pakistan', percentage: 28, count: '1,240' },
  { country: 'USA', percentage: 22, count: '980' },
  { country: 'Germany', percentage: 18, count: '790' },
  { country: 'China', percentage: 16, count: '710' },
  { country: 'Russia', percentage: 16, count: '690' }
]

const latestInvestigations = [
  { id: 'CASE-8092', threat: 'Cobalt Strike Beacon', severity: 'Critical', analyst: 'A. Khan', status: 'In Progress' },
  { id: 'CASE-8091', threat: 'Suspicious PowerShell Script', severity: 'High', analyst: 'S. Vance', status: 'Pending Review' },
  { id: 'CASE-8090', threat: 'Phishing Domain Exposure', severity: 'Medium', analyst: 'M. Chen', status: 'Investigating' },
  { id: 'CASE-8089', threat: 'Unusual SSH Login Attempt', severity: 'Low', analyst: 'R. Taylor', status: 'Closed' }
]

const Stat = ({ label, value, delta, Icon, accent }) => (
  <Card
    className="surface"
    sx={{
      p: 2.3,
      height: '100%',
      borderRadius: '8px',
      borderTop: `3px solid ${accent}`,
      boxShadow: `0 4px 24px -6px ${accent}25`,
      transition: 'transform 0.2s ease, box-shadow 0.2s ease',
      '&:hover': {
        transform: 'translateY(-3px)'
      }
    }}
  >
    <Box sx={{ display: 'flex', justifyContent: 'space-between', color: '#8290a5' }}>
      <Typography sx={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </Typography>
      <Icon color={accent} size={18} />
    </Box>
    <Typography sx={{ mt: 1.5, fontSize: 30, fontWeight: 800, letterSpacing: '-.06em' }}>
      {value ?? '—'}
    </Typography>
    <Typography sx={{ mt: 0.8, fontSize: 11, color: '#708098' }}>
      <span style={{ color: accent, fontWeight: 700 }}>{delta}</span> since last 24 hours
    </Typography>
  </Card>
)

const getMitreColor = (status) => {
  switch (status) {
    case 'Covered': return { bg: 'rgba(110, 231, 199, 0.12)', color: '#6ee7c7', border: 'rgba(110, 231, 199, 0.3)' }
    case 'Partial': return { bg: 'rgba(118, 136, 255, 0.12)', color: '#7688ff', border: 'rgba(118, 136, 255, 0.3)' }
    case 'Needs Review': return { bg: 'rgba(255, 183, 104, 0.12)', color: '#ffb768', border: 'rgba(255, 183, 104, 0.3)' }
    case 'Not Detected': return { bg: 'rgba(255, 102, 120, 0.12)', color: '#ff6678', border: 'rgba(255, 102, 120, 0.3)' }
    default: return { bg: 'rgba(255, 255, 255, 0.05)', color: '#8290a5', border: 'rgba(255, 255, 255, 0.1)' }
  }
}

const getSeverityChip = (severity) => {
  let color = '#7688ff'
  let bg = 'rgba(118, 136, 255, 0.15)'
  if (severity === 'Critical') { color = '#ff6678'; bg = 'rgba(255, 102, 120, 0.15)' }
  if (severity === 'High') { color = '#ffb768'; bg = 'rgba(255, 183, 104, 0.15)' }
  if (severity === 'Medium') { color = '#6ee7c7'; bg = 'rgba(110, 231, 199, 0.15)' }
  return (
    <Chip
      label={severity}
      size="small"
      sx={{
        bgcolor: bg,
        color: color,
        fontWeight: 700,
        fontSize: 10,
        height: 20,
        border: `1px solid ${color}33`
      }}
    />
  )
}

export const Dashboard = () => {
  const [stats, setStats] = useState(null)
  const [charts, setCharts] = useState(null)
  const [loading, setLoading] = useState(true)

  const dashboardSettings = useMemo(() => {
    const saved = localStorage.getItem('dashboardSettings')
    return saved
      ? JSON.parse(saved)
      : {
          threatMap: true,
          mitre: true,
          liveFeed: true,
          recentCases: true,
          iocStats: true
        }
  }, [])

  useEffect(() => {
    Promise.all([dashboardService.getStats(), dashboardService.getCharts()])
      .then(([s, c]) => {
        setStats(s.data.data)
        setCharts(c.data.data)
      })
      .catch(() => toast.error('Unable to refresh live intelligence'))
      .finally(() => setLoading(false))
  }, [])

  const values = stats || fallback
  const severity = charts?.severity || [
    { name: 'Critical', value: 0 },
    { name: 'High', value: 0 },
    { name: 'Medium', value: 0 },
    { name: 'Low', value: 0 }
  ]
  const statuses = charts?.status || []

  return (
    <Box sx={{ p: { xs: 2, md: 4 }, pb: 6, maxWidth: 1600, mx: 'auto' }}>
      <DashboardHeader loading={loading} />

      {/* Top Stats Cards */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Stat label="Total signals" value={values.totalThreats} delta="+12.5%" Icon={FiActivity} accent="#7688ff" />
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Stat label="Critical exposure" value={values.critical} delta="Needs attention" Icon={FiAlertTriangle} accent="#ff6678" />
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <Stat label="High priority" value={values.high} delta="+4.2%" Icon={FiCrosshair} accent="#ffb768" />
        </Grid>

        {dashboardSettings.iocStats && (
          <Grid size={{ xs: 12, sm: 6, md: 3 }}>
            <Stat label="Tracked IOCs" value={values.iocCount} delta="+18 new" Icon={FiDatabase} accent="#6ee7c7" />
          </Grid>
        )}
      </Grid>

      {/* Main Charts & Pipeline Section */}
      <Grid container spacing={2} sx={{ mt: 0.5 }}>
        {/* Threat Severity Chart */}
        <Grid size={{ xs: 12, md: dashboardSettings.recentCases ? 5 : 12 }}>
          <Card className="surface" sx={{ p: { xs: 2, md: 2.5 }, height: 380, borderRadius: 2 }}>
            <Typography sx={{ fontWeight: 800 }}>Threat severity</Typography>
            <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.5 }}>
              Active signals by urgency level
            </Typography>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={severity} innerRadius={70} outerRadius={100} paddingAngle={5} dataKey="value">
                  {severity.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: '#101723', border: '1px solid #2b3a4f', borderRadius: 10 }} />
                <text
                  x="50%"
                  y="48%"
                  textAnchor="middle"
                  fill="#eef4ff"
                  fontSize="25"
                  fontWeight="800"
                >
                  {values.totalThreats}
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
        </Grid>

        {/* Investigation Pipeline */}
        {dashboardSettings.recentCases && (
          <Grid size={{ xs: 12, md: 7 }}>
            <Card className="surface" sx={{ p: { xs: 2, md: 2.5 }, height: 380, borderRadius: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <Box>
                  <Typography sx={{ fontWeight: 800 }}>Investigation pipeline</Typography>
                  <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.5 }}>
                    Cases grouped by current workflow stage
                  </Typography>
                </Box>
                <FiArrowUpRight size={18} color="#70e5c8" />
              </Box>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={statuses} margin={{ top: 20, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#243146" />
                  <XAxis dataKey="name" tick={{ fill: '#8390a2', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: '#8390a2', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: 'rgba(110,231,199,.05)' }}
                    contentStyle={{ background: '#101723', border: '1px solid #2b3a4f', borderRadius: 10 }}
                  />
                  <Bar dataKey="value" fill="#6ee7c7" radius={[5, 5, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          </Grid>
        )}
      </Grid>

      {/* Response Readiness / Live Telemetry */}
      {dashboardSettings.liveFeed && (
        <Card className="surface" sx={{ mt: 2, p: { xs: 2, md: 2.5 }, borderRadius: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Box>
              <Typography sx={{ fontWeight: 800 }}>Response readiness</Typography>
              <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
                Operational checks for the current workspace
              </Typography>
            </Box>
            <FiRefreshCw color="#7688ff" />
          </Box>
          <Grid container spacing={2}>
            {[
              ['Intelligence feed', 94, '#6ee7c7'],
              ['Automated enrichment', 78, '#7688ff'],
              ['Case triage capacity', 63, '#ffb768']
            ].map(([name, value, color]) => (
              <Grid size={{ xs: 12, md: 4 }} key={name}>
                <Box sx={{ p: 1.5, bgcolor: '#0b111c', borderRadius: 2, border: '1px solid #1a2638' }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                    <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{name}</Typography>
                    <Typography className="mono" sx={{ fontSize: 11, fontWeight: 700, color }}>
                      {value}%
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={value}
                    sx={{
                      height: 5,
                      borderRadius: 3,
                      bgcolor: '#233044',
                      '& .MuiLinearProgress-bar': { bgcolor: color, borderRadius: 3 }
                    }}
                  />
                </Box>
              </Grid>
            ))}
          </Grid>
        </Card>
      )}

      {/* Middle Row: SOC Health Card & SOC Overview Card */}
      <Grid container spacing={2} sx={{ mt: 0.5 }}>
        {/* SOC Health Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card className="surface" sx={{ p: { xs: 2, md: 2.5 }, height: 320, borderRadius: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Box>
                <Typography sx={{ fontWeight: 800 }}>SOC Health Monitor</Typography>
                <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
                  Real-time status of critical internal services
                </Typography>
              </Box>
              <FiServer size={18} color="#6ee7c7" />
            </Box>
            <Grid container spacing={1.5}>
              {socHealthServices.map((svc) => (
                <Grid size={{ xs: 12, sm: 6 }} key={svc.name}>
                  <Box
                    sx={{
                      p: 1.5,
                      bgcolor: '#0b111c',
                      borderRadius: 2,
                      border: '1px solid #1a2638',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between'
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <Box
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          bgcolor: svc.status === 'green' ? '#6ee7c7' : svc.status === 'yellow' ? '#ffb768' : '#ff6678',
                          boxShadow: `0 0 10px ${svc.status === 'green' ? '#6ee7c7' : svc.status === 'yellow' ? '#ffb768' : '#ff6678'}`
                        }}
                      />
                      <Typography sx={{ fontSize: 12, fontWeight: 700 }}>{svc.name}</Typography>
                    </Box>
                    <Typography className="mono" sx={{ fontSize: 10, color: '#708098' }}>
                      {svc.latency}
                    </Typography>
                  </Box>
                </Grid>
              ))}
            </Grid>
          </Card>
        </Grid>

        {/* SOC Overview Card */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card className="surface" sx={{ p: { xs: 2, md: 2.5 }, height: 320, borderRadius: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Box>
                <Typography sx={{ fontWeight: 800 }}>SOC Operations Overview</Typography>
                <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
                  Active workload, capacity, and source tracking
                </Typography>
              </Box>
              <FiShield size={18} color="#7688ff" />
            </Box>
            <Grid container spacing={1.5}>
              {[
                { label: 'Open Cases', val: '42', color: '#ff6678', icon: FiFolder },
                { label: 'Closed Cases', val: '1,280', color: '#6ee7c7', icon: FiCheckCircle },
                { label: 'Pending Review', val: '15', color: '#ffb768', icon: FiClock },
                { label: 'Threat Sources', val: '28 Active', color: '#7688ff', icon: FiGlobe },
                { label: 'Active Analysts', val: '8 Duty', color: '#6ee7c7', icon: FiUsers }
              ].map((item, idx) => {
                const IconComponent = item.icon
                return (
                  <Grid size={{ xs: 12, sm: idx === 4 ? 12 : 6 }} key={item.label}>
                    <Box
                      sx={{
                        p: 1.5,
                        bgcolor: '#0b111c',
                        borderRadius: 2,
                        border: '1px solid #1a2638',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between'
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <IconComponent size={16} color={item.color} />
                        <Typography sx={{ fontSize: 12, fontWeight: 600, color: '#8290a5' }}>
                          {item.label}
                        </Typography>
                      </Box>
                      <Typography sx={{ fontSize: 14, fontWeight: 800, color: item.color }}>
                        {item.val}
                      </Typography>
                    </Box>
                  </Grid>
                )
              })}
            </Grid>
          </Card>
        </Grid>
      </Grid>

      {/* Row: Live Threat Feed & Threat Trend Chart */}
      <Grid container spacing={2} sx={{ mt: 0.5 }}>
        {/* Live Threat Feed */}
        <Grid size={{ xs: 12, md: 5 }}>
          <Card className="surface" sx={{ p: { xs: 2, md: 2.5 }, height: 380, borderRadius: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Box>
                <Typography sx={{ fontWeight: 800 }}>Live Threat Feed</Typography>
                <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
                  Real-time ingestion of newly identified signals
                </Typography>
              </Box>
              <FiRadio size={18} color="#ff6678" />
            </Box>
            <Box
              sx={{
                maxHeight: 280,
                overflowY: 'auto',
                pr: 0.5,
                borderRadius: 2,
                '&::-webkit-scrollbar': { width: '4px' },
                '&::-webkit-scrollbar-thumb': { bgcolor: '#233044', borderRadius: '4px' }
              }}
            >
              {liveThreatFeed.map((item) => (
                <Box
                  key={item.id}
                  sx={{
                    p: 1.25,
                    mb: 1,
                    bgcolor: '#0b111c',
                    borderRadius: 2,
                    border: '1px solid #1a2638',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    transition: 'border-color 0.2s ease',
                    '&:hover': { borderColor: '#2b3a4f' }
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Avatar sx={{ width: 28, height: 28, bgcolor: 'rgba(255,102,120,0.1)', color: '#ff6678', fontSize: 12 }}>
                      <FiAlertCircle size={14} />
                    </Avatar>
                    <Box>
                      <Typography sx={{ fontSize: 12, fontWeight: 700, color: '#eef4ff' }}>
                        {item.type}
                      </Typography>
                      <Typography className="mono" sx={{ fontSize: 11, color: '#8290a5' }}>
                        {item.value}
                      </Typography>
                    </Box>
                  </Box>
                  <Box sx={{ textAlign: 'right' }}>
                    {getSeverityChip(item.severity)}
                    <Typography sx={{ fontSize: 10, color: '#708098', mt: 0.5 }}>
                      {item.time}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Box>
          </Card>
        </Grid>

        {/* Threat Trend Line Chart */}
        <Grid size={{ xs: 12, md: 7 }}>
          <Card className="surface" sx={{ p: { xs: 2, md: 2.5 }, height: 380, borderRadius: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Box>
                <Typography sx={{ fontWeight: 800 }}>Threat Trend (7 Days)</Typography>
                <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
                  Weekly volume of detected hostile activity
                </Typography>
              </Box>
              <FiTrendingUp size={18} color="#7688ff" />
            </Box>
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={threatTrendData} margin={{ top: 10, right: 20, left: -20, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#243146" />
                <XAxis dataKey="day" tick={{ fill: '#8390a2', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#8390a2', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: '#101723', border: '1px solid #2b3a4f', borderRadius: 10 }} />
                <Line
                  type="monotone"
                  dataKey="threats"
                  stroke="#7688ff"
                  strokeWidth={3}
                  dot={{ fill: '#7688ff', r: 4 }}
                  activeDot={{ fill: '#6ee7c7', r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </Grid>
      </Grid>

      {/* Row: Top Threat Countries & Quick Actions */}
      <Grid container spacing={2} sx={{ mt: 0.5 }}>
        {/* Top Threat Countries */}
        <Grid size={{ xs: 12, md: 7 }}>
          <Card className="surface" sx={{ p: { xs: 2, md: 2.5 }, height: 320, borderRadius: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Box>
                <Typography sx={{ fontWeight: 800 }}>Top Origin Countries</Typography>
                <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
                  Geographic concentration of incoming hostile vectors
                </Typography>
              </Box>
              <FiGlobe size={18} color="#6ee7c7" />
            </Box>
            <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
              {topThreatCountries.map((item) => (
                <Box key={item.country}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography sx={{ fontSize: 12, fontWeight: 700, color: '#eef4ff' }}>
                      {item.country}
                    </Typography>
                    <Typography className="mono" sx={{ fontSize: 11, color: '#8290a5' }}>
                      {item.count} attacks ({item.percentage}%)
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={item.percentage}
                    sx={{
                      height: 6,
                      borderRadius: 3,
                      bgcolor: '#0b111c',
                      '& .MuiLinearProgress-bar': { bgcolor: '#7688ff', borderRadius: 3 }
                    }}
                  />
                </Box>
              ))}
            </Box>
          </Card>
        </Grid>

        {/* Quick Actions Card */}
        <Grid size={{ xs: 12, md: 5 }}>
          <Card className="surface" sx={{ p: { xs: 2, md: 2.5 }, height: 320, borderRadius: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Box>
                <Typography sx={{ fontWeight: 800 }}>Quick Actions</Typography>
                <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
                  Immediate operations and trigger shortcuts
                </Typography>
              </Box>
              <FiPlusCircle size={18} color="#ffb768" />
            </Box>
            <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
              {[
                { label: 'Upload Intelligence', icon: FiUploadCloud, color: '#7688ff' },
                { label: 'Create Case', icon: FiPlusCircle, color: '#6ee7c7' },
                { label: 'Search IOC', icon: FiSearch, color: '#ffb768' },
                { label: 'Generate Report', icon: FiFileText, color: '#ff6678' }
              ].map((act) => {
                const IconComp = act.icon
                return (
                  <Grid size={{ xs: 6 }} key={act.label}>
                    <Button
                      variant="outlined"
                      fullWidth
                      onClick={() => toast.success(`Triggered: ${act.label}`)}
                      sx={{
                        height: 95,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                        bgcolor: '#0b111c',
                        borderColor: '#243146',
                        color: '#eef4ff',
                        textTransform: 'none',
                        borderRadius: 2,
                        transition: 'all 0.2s ease',
                        '&:hover': {
                          borderColor: act.color,
                          bgcolor: 'rgba(118, 136, 255, 0.05)',
                          transform: 'translateY(-2px)'
                        }
                      }}
                    >
                      <IconComp size={22} color={act.color} />
                      <Typography sx={{ fontSize: 12, fontWeight: 700 }}>
                        {act.label}
                      </Typography>
                    </Button>
                  </Grid>
                )
              })}
            </Grid>
          </Card>
        </Grid>
      </Grid>

      {/* Latest Investigations Table */}
      <Card className="surface" sx={{ mt: 2, p: { xs: 2, md: 2.5 }, borderRadius: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Box>
            <Typography sx={{ fontWeight: 800 }}>Latest Active Investigations</Typography>
            <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
              Current high-priority cases under analyst review
            </Typography>
          </Box>
          <FiFolder size={18} color="#6ee7c7" />
        </Box>
        <TableContainer component={Paper} sx={{ bgcolor: 'transparent', boxShadow: 'none' }}>
          <Table sx={{ minWidth: 650 }}>
            <TableHead>
              <TableRow sx={{ borderColor: '#243146', '& th': { color: '#75849a', fontSize: 12, fontWeight: 700 } }}>
                <TableCell>Case ID</TableCell>
                <TableCell>Threat Title</TableCell>
                <TableCell>Severity</TableCell>
                <TableCell>Assigned Analyst</TableCell>
                <TableCell align="right">Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {latestInvestigations.map((row) => (
                <TableRow
                  key={row.id}
                  sx={{
                    borderColor: '#1a2638',
                    '& td, & th': { color: '#eef4ff', fontSize: 13, border: 0 },
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' }
                  }}
                >
                  <TableCell className="mono" sx={{ color: '#7688ff !important', fontWeight: 700 }}>
                    {row.id}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>{row.threat}</TableCell>
                  <TableCell>{getSeverityChip(row.severity)}</TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Avatar sx={{ width: 22, height: 22, bgcolor: '#243146', color: '#6ee7c7', fontSize: 10 }}>
                        {row.analyst[0]}
                      </Avatar>
                      <Typography sx={{ fontSize: 12 }}>{row.analyst}</Typography>
                    </Box>
                  </TableCell>
                  <TableCell align="right">
                    <Chip
                      label={row.status}
                      size="small"
                      variant="outlined"
                      sx={{
                        borderColor: '#243146',
                        color: '#8290a5',
                        fontSize: 11,
                        height: 22
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {/* Threat Map Section */}
      {dashboardSettings.threatMap && <ThreatMap />}

      {/* MITRE ATT&CK Matrix Section */}
      {dashboardSettings.mitre && (
        <Card className="surface" sx={{ mt: 2, p: { xs: 2, md: 2.5 }, borderRadius: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Box>
              <Typography sx={{ fontWeight: 800 }}>MITRE ATT&CK Framework Coverage</Typography>
              <Typography sx={{ fontSize: 12, color: '#75849a', mt: 0.35 }}>
                Active tactic detection capabilities & navigator grid
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography sx={{ fontSize: 12, color: '#8290a5' }}>Coverage:</Typography>
                <Typography sx={{ fontSize: 14, fontWeight: 800, color: '#6ee7c7' }}>78%</Typography>
              </Box>
              <FiGrid size={18} color="#ffb768" />
            </Box>
          </Box>

          <Box sx={{ mb: 2.5 }}>
            <LinearProgress
              variant="determinate"
              value={78}
              sx={{
                height: 8,
                borderRadius: 4,
                bgcolor: '#0b111c',
                '& .MuiLinearProgress-bar': { bgcolor: '#6ee7c7', borderRadius: 4 }
              }}
            />
          </Box>

          {/* ATT&CK Legend */}
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2.5, mb: 2 }}>
            {['Covered', 'Partial', 'Needs Review', 'Not Detected'].map((st) => {
              const style = getMitreColor(st)
              return (
                <Box key={st} sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                  <Box sx={{ width: 10, height: '2px', bgcolor: style.color, borderRadius: 1 }} />
                  <Typography sx={{ fontSize: 11, color: '#8290a5' }}>{st}</Typography>
                </Box>
              )
            })}
          </Box>

          {/* Navigator Grid */}
          <Grid container spacing={1.5}>
            {mitreTactics.map((tactic) => {
              const style = getMitreColor(tactic.status)
              return (
                <Grid size={{ xs: 12, sm: 6, md: 3 }} key={tactic.name}>
                  <Box
                    sx={{
                      p: 1.5,
                      height: 75,
                      borderRadius: 2,
                      bgcolor: style.bg,
                      border: `1px solid ${style.border}`,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      transition: 'transform 0.15s ease',
                      '&:hover': {
                        transform: 'translateY(-2px)'
                      }
                    }}
                  >
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <Typography sx={{ fontSize: 12, fontWeight: 700, color: '#eef4ff' }}>
                        {tactic.name}
                      </Typography>
                      <Typography className="mono" sx={{ fontSize: 10, fontWeight: 700, color: style.color }}>
                        {tactic.count}
                      </Typography>
                    </Box>
                    <Chip
                      label={tactic.status}
                      size="small"
                      sx={{
                        alignSelf: 'flex-start',
                        bgcolor: 'rgba(0,0,0,0.2)',
                        color: style.color,
                        fontWeight: 700,
                        fontSize: 9,
                        height: 18,
                        border: `1px solid ${style.border}`
                      }}
                    />
                  </Box>
                </Grid>
              )
            })}
          </Grid>
        </Card>
      )}

      {/* Enterprise Footer */}
      <Box
        sx={{
          mt: 4,
          pt: 2.5,
          borderTop: '1px solid #1a2638',
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 1.5,
          color: '#708098',
          fontSize: 12
        }}
      >
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2.5 }}>
          <Typography sx={{ fontSize: 12, color: '#708098' }}>
            ThreatNeXus Platform: <strong style={{ color: '#eef4ff' }}>v4.2.0-Enterprise</strong>
          </Typography>
          <Typography sx={{ fontSize: 12, color: '#708098' }}>
            Backend API: <strong style={{ color: '#6ee7c7' }}>v2.18.4</strong>
          </Typography>
          <Typography sx={{ fontSize: 12, color: '#708098' }}>
            Database: <strong style={{ color: '#eef4ff' }}>PostgreSQL 16.2 (Cluster Active)</strong>
          </Typography>
        </Box>
        <Typography className="mono" sx={{ fontSize: 11, color: '#8290a5' }}>
          Last Sync: {new Date().toLocaleTimeString()} UTC
        </Typography>
      </Box>
    </Box>
  )
}