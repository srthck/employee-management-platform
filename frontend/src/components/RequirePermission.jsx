import { useContext } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { canAny } from '../utils/permissions';

/**
 * RequirePermission
 *
 * Renders nested routes only when the user holds at least one of `anyOf`;
 * everyone else is sent to `fallback` (their own home). The API enforces the
 * same permissions independently.
 */
export default function RequirePermission({ anyOf, fallback }) {
  const { user } = useContext(AuthContext);

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!canAny(user, anyOf)) {
    return <Navigate to={fallback} replace />;
  }

  return <Outlet />;
}
