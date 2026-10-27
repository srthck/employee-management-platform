import { useCallback, useContext, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import * as employeeService from '../services/employeeService';
import * as profileService from '../services/employeeProfileService';
import ReadinessPanel from '../components/employee360/ReadinessPanel';
import EmploymentSection from '../components/employee360/EmploymentSection';
import CompensationSection from '../components/employee360/CompensationSection';
import StatutorySection from '../components/employee360/StatutorySection';
import BankSection from '../components/employee360/BankSection';
import DocumentsSection from '../components/employee360/DocumentsSection';
import { ReadinessBadge, formatDate } from '../components/employee360/shared';

/**
 * Employee 360 — one place to answer "Can this employee safely enter the next
 * payroll?": identity, effective-dated employment, compensation, statutory
 * identifiers and bank account (masked), documents, and payroll readiness.
 *
 * Each section loads its own data and asks the page to refresh the header and
 * readiness after a change.
 */
export default function EmployeeProfile() {
  const { id } = useParams();
  const { user } = useContext(AuthContext);

  const [employee, setEmployee] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    Promise.all([employeeService.getEmployee(id), profileService.getEmployeeReadiness(id)])
      .then(([employeeResult, readinessResult]) => {
        if (!active) return;
        setEmployee(employeeResult.data?.employee);
        setReadiness(readinessResult.data);
        setError('');
      })
      .catch((err) => active && setError(err.response?.data?.message || 'Unable to load employee.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [id, version]);

  if (loading) {
    return <div className="panel py-16 text-center text-sm text-ink-2">Loading employee...</div>;
  }

  if (!employee) {
    return (
      <div className="space-y-6">
        <Link to="/employees" className="text-sm font-semibold text-crimson hover:underline">← Employees</Link>
        <div className="alert alert-danger">{error || 'Employee not found.'}</div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <Link to="/employees" className="text-sm font-semibold text-crimson transition hover:underline">
        ← Employees
      </Link>

      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="eyebrow">Employee 360</p>
          <h1 className="page-title">{employee.firstName} {employee.lastName}</h1>
          <p className="page-subtitle">
            {[employee.employeeCode, employee.position, employee.department, employee.email].filter(Boolean).join(' · ')}
            {employee.hireDate && ` · joined ${formatDate(employee.hireDate)}`}
          </p>
        </div>
        {readiness && <ReadinessBadge state={readiness.readiness.state} />}
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}

      <ReadinessPanel data={readiness} />

      <div className="grid gap-6 xl:grid-cols-2">
        <EmploymentSection employeeId={id} user={user} onChanged={refresh} />
        <CompensationSection employeeId={id} user={user} onChanged={refresh} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <StatutorySection employeeId={id} user={user} onChanged={refresh} />
        <BankSection employeeId={id} user={user} onChanged={refresh} />
      </div>

      <DocumentsSection employeeId={id} user={user} onChanged={refresh} />
    </div>
  );
}
