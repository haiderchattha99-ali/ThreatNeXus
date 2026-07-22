import { useContext } from 'react'
import { AuthContext } from '../context/AuthContext'

export const useAuth = () => {
  const auth = useContext(AuthContext)

  if (!auth) {
    throw new Error(
      'useAuth must be used inside an AuthProvider.'
    )
  }

  return auth
}