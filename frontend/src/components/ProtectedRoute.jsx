import { useContext } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';

/**
 * ProtectedRoute
 *
 * Guards routes that require authentication.
 *
 * Behavior:
 * 1. While auth state is loading → show themed loading screen.
 * 2. If user is authenticated → render the nested <Outlet />.
 * 3. If not authenticated → redirect to /login.
 */

function LoadingSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-porcelain">
      <div className="flex flex-col items-center gap-5">

        {/* PayGuard mark */}
        <div className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-crimson text-lg font-semibold text-white shadow-sm">
          P
        </div>

        {/* Loading spinner */}
        <div
          className="h-9 w-9 animate-spin rounded-full border-4 border-crimson-tint border-t-crimson"
          aria-label="Loading"
        />

        <div className="text-center">
          <p className="text-sm font-medium text-ink">
            Verifying session
          </p>

          <p className="mt-1 text-xs tracking-wide text-ink-2">
            Please wait…
          </p>
        </div>

      </div>
    </div>
  );
}

export default function ProtectedRoute() {
  const { user, loading } = useContext(AuthContext);

  if (loading) {
    return <LoadingSpinner />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}