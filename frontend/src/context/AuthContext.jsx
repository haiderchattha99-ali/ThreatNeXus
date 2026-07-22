import React, {
  createContext,
  useState,
  useEffect,
  useCallback,
} from 'react'

import axios from 'axios'

export const AuthContext = createContext()

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const storedToken = localStorage.getItem('token')
    const storedUser = localStorage.getItem('user')

    if (storedToken) {
      setToken(storedToken)
      axios.defaults.headers.common[
        'Authorization'
      ] = `Bearer ${storedToken}`
    }

    if (storedUser) {
      setUser(JSON.parse(storedUser))
    }

    setLoading(false)
  }, [])

  const login = useCallback((jwtToken, userData) => {
    localStorage.setItem('token', jwtToken)
    localStorage.setItem('user', JSON.stringify(userData))

    axios.defaults.headers.common[
      'Authorization'
    ] = `Bearer ${jwtToken}`

    setToken(jwtToken)
    setUser(userData)
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')

    delete axios.defaults.headers.common['Authorization']

    setToken(null)
    setUser(null)
  }, [])

  const updateUser = useCallback((updatedUser) => {
    setUser(updatedUser)
    localStorage.setItem(
      'user',
      JSON.stringify(updatedUser)
    )
  }, [])

  const isAuthenticated = Boolean(token)

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        login,
        logout,
        updateUser,
        isAuthenticated,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}