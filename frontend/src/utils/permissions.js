import { ROLES } from "../constants/roles";

export const PERMISSIONS = {
  dashboard: [
    ROLES.ADMIN,
    ROLES.ANALYST,
    ROLES.REVIEWER,
    ROLES.VIEWER,
  ],

  threats: [
    ROLES.ADMIN,
    ROLES.ANALYST,
    ROLES.REVIEWER,
    ROLES.VIEWER,
  ],

  upload: [
    ROLES.ADMIN,
    ROLES.ANALYST,
  ],

  cases: [
    ROLES.ADMIN,
    ROLES.ANALYST,
    ROLES.REVIEWER,
  ],

  organizations: [
    ROLES.ADMIN,
  ],

  analytics: [
    ROLES.ADMIN,
    ROLES.ANALYST,
    ROLES.REVIEWER,
    ROLES.VIEWER,
  ],

  notifications: [
    ROLES.ADMIN,
    ROLES.ANALYST,
    ROLES.REVIEWER,
    ROLES.VIEWER,
  ],

  settings: [
    ROLES.ADMIN,
  ],

  profile: [
    ROLES.ADMIN,
    ROLES.ANALYST,
    ROLES.REVIEWER,
    ROLES.VIEWER,
  ],
};

export const hasPermission = (role, permission) => {
  return PERMISSIONS[permission]?.includes(role);
};