import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { Toaster } from 'react-hot-toast'

import App from './App.jsx'
import './index.css'
import { AuthProvider } from './context/AuthContext'
import theme from './theme'
import { color, radius, font } from './theme/tokens'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AuthProvider>
        <App />
        {/* Toasts are transient confirmations only. Anything an analyst must be
            able to re-read — an error, a denial, a validation failure — is
            rendered in the page as well, because a toast that has faded is
            unreachable to a screen-reader user who arrived late. */}
        <Toaster
          position="bottom-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: color.surfaceRaised,
              color: color.text,
              border: `1px solid ${color.borderStrong}`,
              borderRadius: `${radius.sm}px`,
              fontFamily: font.ui,
              fontSize: 13,
            },
          }}
        />
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>
)
