import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as meService from '../services/meService';
import PayslipView from '../components/PayslipView';

const money = (value) =>
  typeof value === 'number'
    ? new Intl.NumberFormat('en-IN', {
        style: 'currency',
        currency: 'INR',
        minimumFractionDigits: 2,
      }).format(value)
    : 'Not available';

const periodLabel = (month, year) =>
  new Date(year, month - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });

export default function MyPayslips() {
  const { id } = useParams();

  const [payslips, setPayslips] = useState([]);
  const [payslip, setPayslip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');

    const request = id
      ? meService.getMyPayslip(id).then((r) => setPayslip(r.data?.payslip || null))
      : meService.listMyPayslips().then((r) => setPayslips(r.data?.payslips || []));

    request
      .catch((e) =>
        setError(e.response?.data?.message || 'Unable to load payslips.')
      )
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="panel py-16 text-center text-sm text-ink-2">
        Loading payslips...
      </div>
    );
  }

  if (id) {
    return (
      <div className="space-y-8">
        <Link
          to="/my/payslips"
          className="inline-flex items-center text-sm font-semibold text-crimson transition hover:text-crimson-strong"
        >
          ← All payslips
        </Link>

        {error || !payslip ? (
          <div className="alert alert-danger" role="alert">
            {error || 'Payslip not found.'}
          </div>
        ) : (
          <PayslipView payslip={payslip} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <p className="eyebrow">Self-service</p>
        <h1 className="page-title">My payslips</h1>
        <p className="page-subtitle">
          Finalized payslips, with every deduction explained.
        </p>
      </div>

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      <section className="panel">
        {payslips.length === 0 ? (
          <div className="empty-state">
            <p className="font-semibold text-ink">
              No finalized payslips yet.
            </p>
            <p className="mt-1 text-sm">
              Payslips appear here once your employer finalizes a payroll run.
            </p>
          </div>
        ) : (
          <div tabIndex={0} className="pg-scrollbar overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="text-right">Gross</th>
                  <th className="text-right">Deductions</th>
                  <th className="text-right">Net pay (before TDS)</th>
                  <th className="text-right">Payslip</th>
                </tr>
              </thead>
              <tbody>
                {payslips.map((item) => (
                  <tr key={item.id}>
                    <td className="font-semibold text-ink">
                      {periodLabel(item.periodMonth, item.periodYear)}
                    </td>
                    <td className="text-right tabular-nums">{money(item.grossMonthly)}</td>
                    <td className="text-right tabular-nums">{money(item.totalDeductions)}</td>
                    <td className="text-right font-semibold tabular-nums text-ink">
                      {money(item.netPayBeforeTDS)}
                    </td>
                    <td className="text-right">
                      <Link className="btn btn-small" to={`/my/payslips/${item.id}`}>
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
