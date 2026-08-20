import { useEffect, useState } from 'react';
import * as complianceService from '../services/complianceService';

export default function Compliance() {
  const [rules, setRules] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    complianceService.listRules({ limit: 100 })
      .then((result) => setRules(result.data?.rules || []))
      .catch((err) => setError(err.response?.data?.message || 'Unable to load compliance rules.'))
      .finally(() => setLoading(false));
  }, []);

  return <div className="space-y-8">
    <div><p className="eyebrow">Versioned configuration</p><h1 className="page-title">Compliance Center</h1><p className="page-subtitle">Read-only statutory rule versions returned by the backend.</p></div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    <div className="grid gap-4 md:grid-cols-3"><RuleCard title="EPF" rules={rules.filter((rule) => rule.ruleType === 'EPF')} /><RuleCard title="ESI" rules={rules.filter((rule) => rule.ruleType === 'ESI')} /><RuleCard title="PT" rules={rules.filter((rule) => rule.ruleType === 'PT')} /></div>
    <section className="panel"><div className="flex items-center justify-between"><div><p className="eyebrow">Rule registry</p><h2 className="section-title">Configured rule versions</h2></div><span className="status status-info">Read only</span></div>{loading ? <div className="py-14 text-center text-sm text-[#6d8188]">Loading compliance rules...</div> : rules.length === 0 ? <div className="empty-state"><p className="font-semibold">No rule configuration available.</p><p className="mt-1 text-sm">The backend returned no configured statutory rules.</p></div> : <div className="pg-scrollbar mt-5 overflow-x-auto"><table className="data-table"><thead><tr><th>Rule type</th><th>Jurisdiction</th><th>Effective from</th><th>Effective to</th><th>Source</th><th /></tr></thead><tbody>{rules.map((rule) => <tr key={rule._id}><td className="font-semibold">{rule.ruleType}</td><td>{rule.jurisdiction}</td><td>{formatDate(rule.effectiveFrom)}</td><td>{rule.effectiveTo ? formatDate(rule.effectiveTo) : 'Open-ended'}</td><td>{rule.description || 'Not provided'}</td><td className="text-right"><button type="button" className="btn btn-small" onClick={() => setSelected(rule)}>View detail</button></td></tr>)}</tbody></table></div>}</section>
    <section className="grid gap-4 md:grid-cols-2"><div className="panel"><p className="eyebrow">TDS</p><h2 className="section-title">DEFERRED</h2><p className="mt-3 text-sm leading-6 text-[#687a81]">TDS calculation is outside the current MVP scope.</p></div><div className="panel"><p className="eyebrow">Attendance adjustment</p><h2 className="section-title">DEFERRED</h2><p className="mt-3 text-sm leading-6 text-[#687a81]">No attendance subsystem exists in the current backend.</p></div></section>
    {selected && <RuleDetail rule={selected} onClose={() => setSelected(null)} />}
  </div>;
}
function RuleCard({ title, rules }) { return <div className="panel"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{title}</h2><span className={`status ${rules.length ? 'status-success' : 'status-neutral'}`}>{rules.length ? `${rules.length} version${rules.length === 1 ? '' : 's'}` : 'Unavailable'}</span></div><p className="mt-4 text-sm text-[#687a81]">{rules.length ? 'Configured in the backend rule registry.' : 'No rule returned by the backend.'}</p></div>; }
function RuleDetail({ rule, onClose }) { return <div className="dialog-backdrop"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="rule-detail-title"><div className="flex items-start justify-between"><div><p className="eyebrow">Rule detail</p><h2 id="rule-detail-title" className="section-title">{rule.ruleType} · {rule.jurisdiction}</h2></div><button type="button" className="icon-button" aria-label="Close rule detail" onClick={onClose}>×</button></div><dl className="mt-6 divide-y divide-[#edf1f2] text-sm">{[['Version ID', rule._id], ['Effective from', formatDate(rule.effectiveFrom)], ['Effective to', rule.effectiveTo ? formatDate(rule.effectiveTo) : 'Open-ended'], ['Source', rule.description || 'Not provided'], ['Created', formatDate(rule.createdAt)]].map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-3"><dt className="text-[#6d8188]">{label}</dt><dd className="text-right font-medium">{value}</dd></div>)}</dl><p className="mt-5 text-xs leading-5 text-[#687a81]">This exact rule version can be preserved with historical payroll records.</p></div></div>; }
function formatDate(value) { return value ? new Date(value).toLocaleDateString('en-IN') : 'Not available'; }
