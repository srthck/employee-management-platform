import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import RequirePermission from './components/RequirePermission';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Overview';
import PayGuardLayout from './components/PayGuardLayout';
import Employees from './pages/Employees';
import EmployeeProfile from './pages/EmployeeProfile';
import PayrollRuns from './pages/PayrollRuns';
import PayrollRunDetail from './pages/PayrollRunDetail';
import Compensation from './pages/Compensation';
import Snapshot from './pages/Snapshot';
import Compliance from './pages/Compliance';
import Audit from './pages/Audit';
import Settings from './pages/Settings';
import MyPayslips from './pages/MyPayslips';
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
 *   Protected (requires a valid session; access is permission-based):
 *     staff (admin, payroll admin/approver, HR manager, auditor)
 *                     → payroll operations (/dashboard, /employees, /payroll, ...)
 *     employee        → self-service (/my/payslips)
 *     everyone        → /settings
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
          <Route element={<RequirePermission anyOf={['payroll.read', 'employee.read']} fallback="/my/payslips" />}>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/employees" element={<Employees />} />
            <Route path="/employees/:id" element={<EmployeeProfile />} />
            <Route path="/payroll" element={<PayrollRuns />} />
            <Route path="/payroll/:id" element={<PayrollRunDetail />} />
            <Route path="/compensation" element={<Compensation />} />
            <Route path="/snapshots/:id" element={<Snapshot />} />
            <Route path="/compliance" element={<Compliance />} />
            <Route path="/audit" element={<Audit />} />
          </Route>

          <Route element={<RequirePermission anyOf={['self.service']} fallback="/dashboard" />}>
            <Route path="/my/payslips" element={<MyPayslips />} />
            <Route path="/my/payslips/:id" element={<MyPayslips />} />
          </Route>

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
    <ThemeProvider>
      <AuthProvider>
        <Router>
          <AppRoutes />
        </Router>
      </AuthProvider>
    </ThemeProvider>
  );
}
