/**
 * Identity helpers shared by controllers.
 *
 * Actor and company are ALWAYS derived from the authenticated session
 * (req.user, populated by authMiddleware from the database) and never from the
 * request body, query or params.
 *
 * companyId: admins created through registration own their workspace, so the
 * company is their own Admin _id. Users created inside a workspace (managers)
 * carry an explicit companyId. authMiddleware resolves both cases.
 */

export const actorFromRequest = (req) => ({
  id: req.user.id,
  email: req.user.email,
  role: req.user.role,
  name: req.user.name,
});

export const companyIdFromRequest = (req) => req.user.companyId || req.user.id;

export const notFound = (message) => Object.assign(new Error(message), { statusCode: 404 });
