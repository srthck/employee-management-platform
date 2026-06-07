import { useContext } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';

/**
 * ProtectedRoute
 *
 * Guards routes that require authentication.
 *
 * Behavior:
 * 1. While auth state is loading (token verification in progress) → show spinner.
 *    This prevents premature redirects on page refresh.
 * 2. If user is authenticated → render the nested <Outlet />.
 * 3. If not authenticated → redirect to /login.
 */

function LoadingSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 rounded-full border-4 border-violet-500 border-t-transparent animate-spin" />
        <p className="text-slate-400 text-sm tracking-wide">Verifying session…</p>
      </div>
    </div>
  );
}

export default function ProtectedRoute() {
  const { user, loading } = useContext(AuthContext);

  if (loading) return <LoadingSpinner />;
  if (!user) return <Navigate to="/login" replace />;

  return <Outlet />;
}
