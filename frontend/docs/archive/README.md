# ThreatNeXus - Cybersecurity Threat Intelligence Platform

A modern, production-ready React + Vite frontend for comprehensive threat intelligence and cybersecurity management.

## 🚀 Features

- **Authentication & Authorization**: Secure JWT-based login system with role-based access control
- **Dashboard**: Real-time threat statistics with interactive charts and visualizations
- **Threat Management**: Full-featured data grid with search, filtering, sorting, and bulk operations
- **CSV Upload**: Drag-and-drop file upload with progress tracking
- **User Profile**: Personalized user information and account details
- **Dark Mode SOC Dashboard**: Professional cybersecurity-focused UI design
- **Responsive Design**: Fully responsive across all device sizes
- **Real-time Updates**: Live data syncing with backend API

## 📋 Tech Stack

- **Framework**: React 19 with Vite
- **UI Library**: Material-UI (MUI) v9
- **Routing**: React Router DOM v7
- **Data Fetching**: Axios with interceptors
- **Charts**: Recharts
- **Icons**: React Icons
- **Notifications**: React Hot Toast
- **Styling**: Material-UI theme system

## 🛠️ Installation

### Prerequisites
- Node.js >= 16
- npm or yarn

### Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

The app will be available at `http://localhost:5173`

## 📁 Project Structure

```
src/
├── components/              # Reusable UI components
│   ├── Navbar.jsx          # Top navigation bar
│   ├── Sidebar.jsx         # Navigation sidebar
│   └── ProtectedRoute.jsx  # Route protection wrapper
├── context/                 # React Context
│   └── AuthContext.jsx     # Authentication state management
├── hooks/                   # Custom React hooks
│   └── useAuth.js          # Auth hook
├── pages/                   # Page components
│   ├── Login.jsx           # Login page
│   ├── Dashboard.jsx       # Main dashboard
│   ├── Threats.jsx         # Threat management
│   ├── Upload.jsx          # CSV upload
│   └── Profile.jsx         # User profile
├── services/               # API services
│   └── api.js              # Axios instance & endpoints
├── App.jsx                 # Main app component
├── main.jsx                # Entry point
└── index.css               # Global styles
```

## 🔐 Authentication

The app uses JWT-based authentication with the following flow:

1. User logs in with email/password
2. Backend returns JWT token and user data
3. Token is stored in localStorage
4. All subsequent requests include the token in Authorization header
5. Protected routes redirect unauthenticated users to login

### Default Test Credentials
```
Email: ali@example.com
Password: password123
```

## 🌐 API Endpoints

Backend base URL: `http://localhost:5000/api`

### Authentication
- `POST /auth/login` - User login

### Dashboard
- `GET /dashboard/stats` - Dashboard statistics
- `GET /dashboard/charts` - Chart data

### Threats
- `GET /threats` - Get all threats with pagination
- `GET /threats/search` - Search threats
- `PATCH /threats/:id/status` - Update threat status
- `DELETE /threats/:id` - Delete threat
- `POST /threats/upload` - Upload CSV file

## 🎨 Theme & Colors

- **Background**: `#0d1117` (Dark)
- **Primary**: `#58a6ff` (Cyber Blue)
- **Secondary**: `#1f6feb` (Deep Blue)
- **Success**: `#3fb950` (Green)
- **Warning**: `#d29922` (Orange)
- **Error**: `#f85149` (Red)

## 📊 Dashboard Features

### Statistics Cards
- Total Threats
- Critical Threats
- High Priority Threats
- IOC Count

### Visualizations
- Threat Severity Pie Chart
- Threat Status Bar Chart
- IOC Types Distribution

## 🔍 Threat Management

Features include:
- Paginated data grid
- Search functionality
- Status filtering and updates
- Risk score display
- Severity badges
- Bulk delete operations
- Confirmation dialogs

## 📤 CSV Upload

Upload threats in bulk with:
- Drag-and-drop support
- File validation
- Progress tracking
- Error reporting
- Success feedback

### CSV Format
```
id,name,severity,status,riskScore,iocCount,description
```

## 🔒 Security

- JWT token management
- Protected routes
- Axios interceptors for auth
- CORS-enabled requests
- Input validation
- Error handling

## 🚀 Performance Optimizations

- Code splitting with React Router
- Lazy component loading
- Memoization where needed
- Efficient re-renders
- Optimized API calls

## 📱 Responsive Breakpoints

- Mobile: < 600px
- Tablet: 600px - 960px
- Desktop: > 960px

## 🐛 Error Handling

- API error interceptors
- User-friendly error messages
- Toast notifications
- Form validation
- Network error recovery

## 📝 Component Documentation

### ProtectedRoute
Wraps routes that require authentication. Redirects unauthenticated users to login.

### Navbar
Contains application title and user menu with profile and logout options.

### Sidebar
Navigation menu with links to main sections: Dashboard, Threats, Upload.

## 🔄 State Management

- **Auth**: React Context + localStorage
- **Page State**: React hooks (useState, useEffect)
- **API State**: Axios + React hooks

## 🎯 Future Enhancements

- Advanced filtering
- Custom date ranges
- Threat timeline visualization
- Export to CSV/PDF
- Real-time WebSocket updates
- Dark/Light theme toggle
- Internationalization (i18n)
- Role-based permissions
- Audit logging

## 📞 Support

For issues or questions, please refer to the backend API documentation or contact the development team.

## 📄 License

This project is part of ThreatNeXus - Cybersecurity Threat Intelligence Platform.
