import { permissionsForRole } from './permissions.js';

/**
 * Maps a Mongoose Admin document to a public API user object.
 * Never includes password or internal fields. `permissions` lets clients show
 * only what the user can do; the API enforces the same permissions itself.
 */
export const formatUserResponse = (admin) => {
  if (!admin) {
    return null;
  }

  return {
    id: admin._id.toString(),
    name: admin.name,
    email: admin.email,
    role: admin.role,
    isActive: admin.isActive,
    companyId: String(admin.companyId || admin._id),
    permissions: permissionsForRole(admin.role),
  };
};
