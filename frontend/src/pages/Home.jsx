import { useEffect, useState, useContext } from 'react';
import { Link } from 'react-router-dom';
import apiClient from '../services/api';
import { AuthContext } from '../contexts/AuthContext';

/**
 * Home Page Component
 * Shows application status and auth state
 */

export default function Home() {
  const { isAuthenticated, user, logout } = useContext(AuthContext);
  const [apiStatus, setApiStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const checkAPI = async () => {
      try {
        const response = await apiClient.get('/health');
        setApiStatus(response.data);
        setError(null);
      } catch (err) {
        setError(err.message);
        setApiStatus(null);
      } finally {
        setLoading(false);
      }
    };

    checkAPI();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-neutral-50">
      {/* Navbar */}
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <h2 className="text-xl font-bold text-primary-600">EMS</h2>
          <div className="flex gap-4">
            {isAuthenticated ? (
              <>
                <span className="text-neutral-700">Welcome, {user?.name}!</span>
                <Link
                  to="/dashboard"
                  className="text-primary-600 hover:text-primary-700 font-medium"
                >
                  Dashboard
                </Link>
                <button
                  onClick={logout}
                  className="text-neutral-600 hover:text-neutral-700"
                >
                  Logout
                </button>
              </>
            ) : (
              <>
                <Link
                  to="/login"
                  className="text-primary-600 hover:text-primary-700 font-medium"
                >
                  Sign In
                </Link>
                <Link
                  to="/register"
                  className="text-primary-600 hover:text-primary-700 font-medium"
                >
                  Sign Up
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-4xl font-bold text-neutral-900 mb-4">
            Employee Management System
          </h1>
          <p className="text-lg text-neutral-600">
            Enterprise-grade employee management platform
          </p>
        </div>

        {/* Status Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* API Status */}
          <div className="card">
            <h2 className="text-xl font-semibold text-neutral-900 mb-4">
              Backend API Status
            </h2>
            {loading && (
              <p className="text-neutral-600">Checking API connection...</p>
            )}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-red-700 font-medium">Connection Error</p>
                <p className="text-red-600 text-sm mt-2">{error}</p>
              </div>
            )}
            {apiStatus && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <p className="text-green-700 font-medium">✓ Connected</p>
                <p className="text-green-600 text-sm mt-2">
                  Status: {apiStatus.status}
                </p>
                <p className="text-green-600 text-sm">
                  Uptime: {apiStatus.uptime.toFixed(2)}s
                </p>
              </div>
            )}
          </div>

          {/* Auth Status */}
          <div className="card">
            <h2 className="text-xl font-semibold text-neutral-900 mb-4">
              Authentication Status
            </h2>
            {isAuthenticated ? (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <p className="text-green-700 font-medium">✓ Authenticated</p>
                <p className="text-green-600 text-sm mt-2">User: {user?.email}</p>
                <p className="text-green-600 text-sm">Role: {user?.role}</p>
              </div>
            ) : (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-blue-700 font-medium">Not Signed In</p>
                <p className="text-blue-600 text-sm mt-2">
                  Sign up or log in to get started
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Features Status */}
        <div className="mt-12">
          <h3 className="text-lg font-semibold text-neutral-900 mb-4">
            Project Status
          </h3>
          <div className="card">
            <ul className="space-y-3 text-neutral-700">
              <li className="flex items-center">
                <span className="w-2 h-2 bg-green-500 rounded-full mr-3"></span>
                Foundation setup
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-green-500 rounded-full mr-3"></span>
                React + Vite + Tailwind
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-green-500 rounded-full mr-3"></span>
                Authentication System
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-green-500 rounded-full mr-3"></span>
                JWT + Bcrypt Security
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-neutral-400 rounded-full mr-3"></span>
                Employee CRUD (coming soon)
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-neutral-400 rounded-full mr-3"></span>
                Dashboard & Analytics (coming soon)
              </li>
            </ul>
          </div>
        </div>

        {/* Quick Links */}
        <div className="mt-12">
          <h3 className="text-lg font-semibold text-neutral-900 mb-4">
            Get Started
          </h3>
          <div className="flex gap-4 flex-wrap">
            {isAuthenticated ? (
              <Link to="/dashboard" className="btn btn-primary">
                Go to Dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className="btn btn-primary">
                  Sign In
                </Link>
                <Link to="/register" className="btn btn-secondary">
                  Create Account
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
