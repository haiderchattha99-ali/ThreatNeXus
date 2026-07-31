import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

const RoleGuard = ({ allowedRoles, children }) => {
  const { user } = useAuth();

  // User not loaded yet
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // User does not have permission
  if (!allowedRoles.includes(user.role)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-red-600">403</h1>
          <p className="text-lg mt-2">Access Denied</p>
          <p className="text-gray-500">
            You don't have permission to access this page.
          </p>
        </div>
      </div>
    );
  }

  return children;
};

export default RoleGuard;