import { useContext } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import ProoflineMark from './site/ProoflineMark';

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
    <div className="pg-canvas flex min-h-screen items-center justify-center p-6">
      <div className="panel panel-float flex flex-col items-center gap-5 px-10 py-9">

        {/* PayGuard mark */}
        <ProoflineMark size={38} />

        {/* Loading spinner */}
        <div
          className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--pg-glass-line)] border-t-crimson"
          aria-label="Loading"
        />

        <div className="text-center">
          <p className="text-sm font-semibold text-ink">
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