import { useEffect, useState } from 'react';
import apiClient from '../services/api';

/**
 * Home Page Component
 * Placeholder for future dashboard and employee list
 */

export default function Home() {
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

          {/* Project Info */}
          <div className="card">
            <h2 className="text-xl font-semibold text-neutral-900 mb-4">
              Project Status
            </h2>
            <ul className="space-y-3 text-neutral-700">
              <li className="flex items-center">
                <span className="w-2 h-2 bg-primary-600 rounded-full mr-3"></span>
                Foundation setup complete
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-primary-600 rounded-full mr-3"></span>
                React + Vite configured
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-primary-600 rounded-full mr-3"></span>
                Tailwind CSS ready
              </li>
              <li className="flex items-center">
                <span className="w-2 h-2 bg-neutral-400 rounded-full mr-3"></span>
                Authentication (coming next)
              </li>
            </ul>
          </div>
        </div>

        {/* Quick Links */}
        <div className="mt-12">
          <h3 className="text-lg font-semibold text-neutral-900 mb-4">
            Quick Links
          </h3>
          <div className="flex gap-4 flex-wrap">
            <button className="btn btn-primary">
              Dashboard (Coming Soon)
            </button>
            <button className="btn btn-secondary">
              Employees (Coming Soon)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
