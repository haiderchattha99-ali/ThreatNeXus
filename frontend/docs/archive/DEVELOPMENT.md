# Development Guide - ThreatNeXus

This guide covers development workflows, architecture decisions, and best practices for the ThreatNeXus frontend.

## Getting Started

### Prerequisites
- Node.js 16+
- npm or yarn
- Git
- A running ThreatNeXus backend API (on port 5000)

### Initial Setup

```bash
# Clone the repository
git clone <repo-url>
cd threat-nexus

# Install dependencies
npm install

# Create environment file
cp .env.example .env.local

# Start development server
npm run dev
```

The app will be available at `http://localhost:5173`

## Project Architecture

### State Management
- **Authentication**: React Context API (`AuthContext`) with localStorage persistence
- **Component State**: React Hooks (useState, useEffect)
- **API State**: Axios with interceptors

### Routing
- Main route protection via `ProtectedRoute` component
- Dashboard as home page for authenticated users
- Login as the public route for unauthenticated users

### API Integration
- Centralized API service (`src/services/api.js`)
- Axios interceptors for automatic token injection
- Error handling with user-friendly messages

## Code Organization

### Components (`src/components/`)
- **Navbar**: Top navigation with user menu
- **Sidebar**: Left navigation menu
- **ProtectedRoute**: Route wrapper for authentication

### Pages (`src/pages/`)
- **Login**: Authentication page
- **Dashboard**: Main analytics dashboard
- **Threats**: Threat management and search
- **Upload**: CSV file upload
- **Profile**: User information

### Services (`src/services/`)
- **api.js**: Axios configuration and API endpoints

### Context (`src/context/`)
- **AuthContext.jsx**: Authentication state and methods

### Hooks (`src/hooks/`)
- **useAuth.js**: Custom hook for accessing auth context

## Development Workflow

### Adding a New Page

1. Create page component in `src/pages/PageName.jsx`
2. Add route in `src/App.jsx`
3. Add navigation link in `src/components/Sidebar.jsx`
4. Implement page logic and UI

Example:
```jsx
// src/pages/NewPage.jsx
import React from 'react'
import { Box, Typography } from '@mui/material'

export const NewPage = () => {
  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h3">New Page</Typography>
    </Box>
  )
}
```

### Adding a New Component

1. Create component in `src/components/ComponentName.jsx`
2. Export from component file
3. Import where needed
4. Follow MUI component patterns

### Adding API Endpoints

1. Add method to appropriate service in `src/services/api.js`
2. Use in components with try/catch error handling
3. Show toast notification for user feedback

Example:
```javascript
// In api.js
export const newService = {
  getItem: (id) => apiClient.get(`/endpoint/${id}`),
  createItem: (data) => apiClient.post('/endpoint', data),
}

// In component
try {
  const response = await newService.getItem(id)
  // handle response
} catch (error) {
  toast.error('Failed to load item')
}
```

## Styling Guidelines

### Theme System
- Uses Material-UI theme system defined in `src/main.jsx`
- Primary color: `#58a6ff` (Cyber Blue)
- Dark background: `#0d1117`
- Always use theme colors instead of hardcoded values

### Component Styling
- Prefer MUI's `sx` prop for inline styles
- Use semantic color tokens
- Maintain consistent spacing (8px grid)

### CSS Best Practices
- Global styles in `src/index.css`
- Component-specific styles in component files
- Use Tailwind-like spacing: `p: 2, mb: 3, gap: 2`

## Authentication Flow

```
User Login
    ↓
POST /auth/login (email, password)
    ↓
Backend returns { token, user }
    ↓
Store in localStorage
    ↓
Set in AuthContext
    ↓
Redirect to /dashboard
```

### Token Management
- Token stored in `localStorage.token`
- Automatically added to all requests via axios interceptor
- Cleared on logout
- Persists across page refreshes

## Error Handling

### API Errors
- Caught in try/catch blocks
- Displayed via toast notifications
- Specific error messages from backend when available

### Form Validation
- Email format validation on login
- Required field checks
- User-friendly error messages

### Network Errors
- Handled by axios interceptors
- Graceful fallback UI
- Retry capability where appropriate

## Performance Optimization

### Code Splitting
- React Router enables automatic code splitting
- Pages loaded on demand

### Rendering Optimization
- Use React.memo for expensive components
- useCallback for event handlers
- useMemo for computed values

### Build Optimization
- Vite handles bundling and minification
- Source maps disabled in production
- Terser for compression

## Testing Recommendations

### Manual Testing
1. Test all routes as authenticated user
2. Test as unauthenticated user (should redirect to login)
3. Test API calls with mock responses
4. Test error scenarios

### Common Test Scenarios
- Login with invalid credentials
- Search with no results
- Delete with confirmation
- File upload with various file types
- Navigation between pages

## Environment Variables

Create `.env.local` (not committed to git):

```
VITE_API_BASE_URL=http://localhost:5000/api
VITE_APP_NAME=ThreatNeXus
VITE_APP_VERSION=1.0.0
VITE_ENV=development
```

## Build Commands

```bash
# Development
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Lint code
npm run lint
```

## Debugging Tips

### Browser DevTools
- React DevTools extension for component inspection
- Network tab to monitor API calls
- Console for error messages

### Debug Logs
Add console.logs strategically:
```javascript
console.log('[ThreatNeXus] Loading threats...', data)
```

### Common Issues

**CORS Errors**
- Ensure backend is running on port 5000
- Check API_BASE_URL in api.js
- Verify backend CORS configuration

**Token Issues**
- Clear localStorage and re-login
- Check token expiration
- Verify JWT format

**Component Not Rendering**
- Check console for errors
- Verify component is exported correctly
- Ensure route is properly registered

## API Response Formats

### Success Response
```javascript
{
  success: true,
  data: { /* ... */ },
  message: "Operation successful"
}
```

### Error Response
```javascript
{
  success: false,
  message: "Error description",
  errors: { /* field errors */ }
}
```

## Contributing Guidelines

1. Create feature branch: `git checkout -b feature/my-feature`
2. Make changes following code style
3. Test thoroughly
4. Commit with descriptive messages
5. Push and create pull request
6. Code review and merge

## Future Improvements

- [ ] Add unit tests with Jest
- [ ] Add E2E tests with Cypress
- [ ] Implement WebSocket for real-time updates
- [ ] Add dark/light theme toggle
- [ ] Implement advanced filtering
- [ ] Add data export functionality
- [ ] Improve accessibility (a11y)
- [ ] Add keyboard shortcuts
- [ ] Implement progressive web app (PWA)

## Resources

- [React Documentation](https://react.dev)
- [Material-UI Documentation](https://mui.com)
- [React Router Documentation](https://reactrouter.com)
- [Axios Documentation](https://axios-http.com)
- [Vite Documentation](https://vitejs.dev)

## Support

For questions or issues during development, refer to:
- Backend API documentation
- Team chat/communication channels
- GitHub issues
