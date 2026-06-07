/**
 * Maps a Mongoose Admin document to a public API user object.
 * Never includes password or internal fields.
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
  };
};
