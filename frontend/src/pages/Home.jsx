import { useEffect, useState, useContext } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../services/api';
import { AuthContext } from '../contexts/AuthContext';

/**
 * Home Page
 *
 * Landing page showing API health status and authentication state.
 */

export default function Home() {
  const { user, logout } = useContext(AuthContext);
  const [apiStatus, setApiStatus] = useState(null);
  const [apiLoading, setApiLoading] = useState(true);
  const [apiError, setApiError] = useState(null);

  useEffect(() => {
    const checkAPI = async () => {
      try {
        const response = await apiClient.get('/health');
        setApiStatus(response.data);
        setApiError(null);
      } catch (err) {
        setApiError(err.message);
        setApiStatus(null);
      } finally {
        setApiLoading(false);
      }
    };

    checkAPI();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Gradient accent bar */}
      <div className="h-1 bg-gradient-to-r from-violet-600 via-indigo-500 to-violet-600" />

      {/* Navbar */}
      <nav className="bg-slate-900 border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center">
              <span className="text-white text-xs font-bold">EMS</span>
            </div>
            <span className="text-white font-semibold">Employee Management System</span>
          </div>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <span className="text-slate-400 text-sm hidden sm:block">
                  {user.name}
                  <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-violet-500/20 text-violet-300 font-medium">
                    {user.role}
                  </span>
                </span>
                <Link
                  to="/dashboard"
                  className="px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-semibold transition-all"
                >
                  Dashboard
                </Link>
                <button
                  type="button"
                  onClick={logout}
                  className="text-sm text-slate-400 hover:text-white transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-800"
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-sm text-slate-300 hover:text-white transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-800"
                >
                  Sign In
                </Link>
                <Link
                  to="/register"
                  className="px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white text-sm font-semibold transition-all"
                >
                  Get Started
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <div className="max-w-5xl mx-auto px-6 py-20">
        {/* Hero */}
        <div className="text-center mb-16">
          <h1 className="text-5xl font-bold text-white mb-4">
            Employee Management
            <span className="block bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">
              Made Simple
            </span>
          </h1>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto">
            A secure, enterprise-grade platform for administrators to manage employee records with full CRUD operations.
          </p>
          <div className="flex items-center justify-center gap-4 mt-8">
            {user ? (
              <Link
                to="/dashboard"
                className="px-6 py-3 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-semibold transition-all shadow-lg shadow-violet-500/25"
              >
                Open Dashboard →
              </Link>
            ) : (
              <>
                <Link
                  to="/register"
                  className="px-6 py-3 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-semibold transition-all shadow-lg shadow-violet-500/25"
                >
                  Get Started
                </Link>
                <Link
                  to="/login"
                  className="px-6 py-3 rounded-xl border border-slate-700 hover:border-slate-500 text-slate-300 hover:text-white font-semibold transition-all"
                >
                  Sign In
                </Link>
              </>
            )}
          </div>
        </div>

        {/* Status Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {/* API Status */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-slate-700 transition-colors">
            <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Backend API Status
            </h2>
            {apiLoading && <p className="text-slate-500 text-sm">Checking connection…</p>}
            {apiError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                <p className="text-red-400 font-medium text-sm">Connection Error</p>
                <p className="text-red-400/70 text-xs mt-1">{apiError}</p>
              </div>
            )}
            {apiStatus && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
                <p className="text-emerald-400 font-medium text-sm">✓ Connected</p>
                <p className="text-emerald-400/70 text-xs mt-1">Status: {apiStatus.status}</p>
                <p className="text-emerald-400/70 text-xs">Uptime: {apiStatus.uptime?.toFixed(1)}s</p>
              </div>
            )}
          </div>

          {/* Auth Status */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 hover:border-slate-700 transition-colors">
            <h2 className="text-base font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              Authentication Status
            </h2>
            {user ? (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
                <p className="text-emerald-400 font-medium text-sm">✓ Authenticated</p>
                <p className="text-emerald-400/70 text-xs mt-1">{user.email}</p>
                <p className="text-emerald-400/70 text-xs">Role: {user.role}</p>
              </div>
            ) : (
              <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                <p className="text-slate-300 font-medium text-sm">Not signed in</p>
                <p className="text-slate-500 text-xs mt-1">Sign in to manage employees</p>
              </div>
            )}
          </div>
        </div>

        {/* Feature List */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h3 className="text-base font-semibold text-white mb-4">Features</h3>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {[
              { done: true, label: 'Admin authentication (JWT + bcrypt)' },
              { done: true, label: 'Register & login with validation' },
              { done: true, label: 'Protected routes' },
              { done: true, label: 'Employee CRUD (Create, Read, Update, Delete)' },
              { done: true, label: 'Search & filter employees' },
              { done: true, label: 'Pagination & sorting' },
              { done: true, label: 'Dashboard statistics' },
              { done: true, label: 'Rate limiting & input validation' },
            ].map((f) => (
              <li key={f.label} className="flex items-center gap-2 text-sm">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${f.done ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className={f.done ? 'text-slate-300' : 'text-slate-500'}>{f.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
