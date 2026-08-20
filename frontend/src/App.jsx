import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Overview';
import PayGuardLayout from './components/PayGuardLayout';
import Employees from './pages/Employees';
import EmployeeProfile from './pages/EmployeeProfile';
import PayrollRuns from './pages/PayrollRuns';
import PayrollRunDetail from './pages/PayrollRunDetail';
import Snapshot from './pages/Snapshot';
import Compliance from './pages/Compliance';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import './index.css';

/**
 * Main Application Component
 *
 * Routing structure:
 *   Public:
 *     /          → Home (landing / status page)
 *     /login     → Login page
 *     /register  → Register page
 *
 *   Protected (requires valid JWT):
 *     /dashboard → PayGuard payroll overview
 *
 *   Catch-all   → redirect to /
 */

// ─── Routes ──────────────────────────────────────────────────────────────────
function AppRoutes() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />

      {/* Protected routes — ProtectedRoute renders <Outlet /> */}
      <Route element={<ProtectedRoute />}>
        <Route element={<PayGuardLayout />}>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/employees" element={<Employees />} />
          <Route path="/employees/:id" element={<EmployeeProfile />} />
          <Route path="/payroll" element={<PayrollRuns />} />
          <Route path="/payroll/:id" element={<PayrollRunDetail />} />
          <Route path="/snapshots/:id" element={<Snapshot />} />
          <Route path="/compliance" element={<Compliance />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Route>

      {/* Catch-all: redirect to home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

// ─── App Root ────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <AuthProvider>
      <Router>
        <AppRoutes />
      </Router>
    </AuthProvider>
  );
}
