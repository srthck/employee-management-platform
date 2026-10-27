import { useCallback, useContext, useEffect, useState } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import * as companyService from '../services/companyService';
import { can, roleLabel } from '../utils/permissions';

const emptyUser = { name: '', email: '', role: 'payroll_admin', password: '' };

const COMPENSATION_APPROVAL_MODES = [
  { value: 'single', label: 'Applied directly', note: 'Whoever may revise pay can apply a change immediately.' },
  { value: 'maker_checker', label: 'Maker-checker', note: 'A pay change must be proposed by one person and approved by another. The direct salary endpoint is closed.' },
];

const APPROVAL_MODES = [
  { value: 'single', label: 'Single approval', note: 'The person who calculates a run may also finalize it.' },
  { value: 'maker_checker', label: 'Maker-checker', note: 'A different person must finalize what someone else calculated.' },
];

export default function Settings() {
  const { user } = useContext(AuthContext);
  const canReadCompany = can(user, 'company.read');
  const canManageCompany = can(user, 'company.manage');

  const [company, setCompany] = useState(null);
  const [roles, setRoles] = useState([]);
  const [form, setForm] = useState(null);
  const [users, setUsers] = useState([]);
  const [newUser, setNewUser] = useState(emptyUser);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    if (!canReadCompany) return;
    try {
      const result = await companyService.getCompany();
      setCompany(result.data.company);
      setRoles(result.data.roles);
      setForm({ name: result.data.company.name, ...result.data.company.settings });
      if (canManageCompany) {
        setUsers((await companyService.listCompanyUsers()).data.users);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load company settings.');
    }
  }, [canReadCompany, canManageCompany]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (name, action, message) => {
    setSaving(name);
    setError('');
    setSuccess('');
    try {
      await action();
      setSuccess(message);
      await load();
      return true;
    } catch (err) {
      const details = err.response?.data?.errors?.map((e) => e.message).join(' ');
      setError(details || err.response?.data?.message || 'The change could not be saved.');
      return false;
    } finally {
      setSaving('');
    }
  };

  const saveSettings = (event) => {
    event.preventDefault();
    act('settings', () => companyService.updateCompanySettings({
      name: form.name,
      settings: {
        approvalMode: form.approvalMode,
        compensationApprovalMode: form.compensationApprovalMode,
        varianceThresholdPercent: Number(form.varianceThresholdPercent),
        blockFinalizationOnUnexplainedVariance: form.blockFinalizationOnUnexplainedVariance,
      },
    }), 'Company settings saved.');
  };

  const addUser = async (event) => {
    event.preventDefault();
    const created = await act('user', () => companyService.createCompanyUser(newUser), `${newUser.name} can now sign in as ${roleLabel(newUser.role)}.`);
    if (created) setNewUser(emptyUser);
  };

  const updateUser = (target, payload, message) =>
    act(`user-${target.id}`, () => companyService.updateCompanyUser(target.id, payload), message);

  return (
    <div className="space-y-8">
      <div>
        <p className="eyebrow">Administration</p>
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Your account, company controls and team access.</p>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {success && <div className="alert alert-success" role="status">{success}</div>}

      {/* PROFILE */}
      <section className="panel max-w-2xl">
        <p className="eyebrow">Profile</p>
        <h2 className="section-title">Signed-in user</h2>
        <dl className="mt-6 divide-y divide-line text-sm">
          {[
            ['Name', user?.name],
            ['Email', user?.email],
            ['Role', roleLabel(user?.role)],
            ['Company', company?.name || '—'],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 py-3">
              <dt className="text-ink-2">{label}</dt>
              <dd className="font-semibold text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* COMPANY CONTROLS */}
      {canReadCompany && form && (
        <section className="panel max-w-3xl">
          <p className="eyebrow">Payroll controls</p>
          <h2 className="section-title">Company</h2>

          <form onSubmit={saveSettings} className="mt-6 space-y-6">
            <label className="label block">
              Company name
              <input
                className="field mt-2"
                value={form.name}
                disabled={!canManageCompany}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>

            <fieldset>
              <legend className="label">Finalization approval</legend>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {APPROVAL_MODES.map((mode) => (
                  <label
                    key={mode.value}
                    className={`flex cursor-pointer gap-3 rounded-[10px] border p-4 text-sm ${
                      form.approvalMode === mode.value ? 'border-crimson bg-canvas-2' : 'border-line'
                    }`}
                  >
                    <input
                      type="radio"
                      name="approvalMode"
                      className="mt-1 accent-crimson"
                      value={mode.value}
                      checked={form.approvalMode === mode.value}
                      disabled={!canManageCompany}
                      onChange={() => setForm({ ...form, approvalMode: mode.value })}
                    />
                    <span>
                      <span className="block font-semibold text-ink">{mode.label}</span>
                      <span className="text-ink-2">{mode.note}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="label">Pay change approval</legend>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {COMPENSATION_APPROVAL_MODES.map((mode) => (
                  <label
                    key={mode.value}
                    className={`flex cursor-pointer gap-3 rounded-[10px] border p-4 text-sm ${
                      form.compensationApprovalMode === mode.value ? 'border-crimson bg-canvas-2' : 'border-line'
                    }`}
                  >
                    <input
                      type="radio"
                      name="compensationApprovalMode"
                      className="mt-1 accent-crimson"
                      value={mode.value}
                      checked={form.compensationApprovalMode === mode.value}
                      disabled={!canManageCompany}
                      onChange={() => setForm({ ...form, compensationApprovalMode: mode.value })}
                    />
                    <span>
                      <span className="block font-semibold text-ink">{mode.label}</span>
                      <span className="text-ink-2">{mode.note}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-6 sm:grid-cols-2">
              <label className="label block">
                Material variance threshold (%)
                <input
                  type="number"
                  min="1"
                  max="100"
                  className="field mt-2"
                  value={form.varianceThresholdPercent}
                  disabled={!canManageCompany}
                  onChange={(e) => setForm({ ...form, varianceThresholdPercent: e.target.value })}
                />
              </label>

              <label className="flex items-start gap-3 pt-6 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-1 accent-crimson"
                  checked={form.blockFinalizationOnUnexplainedVariance}
                  disabled={!canManageCompany}
                  onChange={(e) => setForm({ ...form, blockFinalizationOnUnexplainedVariance: e.target.checked })}
                />
                <span>
                  Block finalization on unexplained pay changes
                  <span className="block text-xs text-ink-2">
                    Approvers with override permission can proceed with a recorded reason.
                  </span>
                </span>
              </label>
            </div>

            {canManageCompany && (
              <div className="flex justify-end">
                <button type="submit" className="btn btn-primary" disabled={saving !== ''}>
                  {saving === 'settings' ? 'Saving...' : 'Save controls'}
                </button>
              </div>
            )}
          </form>
        </section>
      )}

      {/* TEAM */}
      {canManageCompany && (
        <section className="panel">
          <p className="eyebrow">Access</p>
          <h2 className="section-title">Team</h2>
          <p className="mt-2 max-w-3xl text-sm text-ink-2">
            Roles separate duties: payroll administrators prepare runs, approvers finalize them,
            auditors can only read. Changing a role or deactivating someone signs them out immediately.
          </p>

          <div tabIndex={0} className="pg-scrollbar mt-6 overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                  <th className="text-right">Access</th>
                </tr>
              </thead>
              <tbody>
                {users.map((member) => {
                  const isSelf = member.id === user?.id;
                  return (
                    <tr key={member.id}>
                      <td>
                        <span className="font-semibold text-ink">{member.name}</span>
                        {member.isOwner && <span className="status status-info ml-2">Owner</span>}
                        <span className="block text-xs text-ink-2">{member.email}</span>
                      </td>
                      <td>
                        <select
                          className="field"
                          value={member.role}
                          disabled={isSelf || saving !== ''}
                          aria-label={`Role for ${member.name}`}
                          onChange={(e) => updateUser(member, { role: e.target.value }, `${member.name} is now ${roleLabel(e.target.value)}.`)}
                        >
                          {roles.map((role) => (
                            <option key={role.role} value={role.role}>{role.label}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <span className={`status ${member.isActive ? 'status-success' : 'status-neutral'}`}>
                          {member.isActive ? 'Active' : 'Deactivated'}
                        </span>
                      </td>
                      <td className="text-xs text-ink-2">
                        {member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString('en-IN') : 'Never'}
                      </td>
                      <td className="text-right">
                        {isSelf ? (
                          <span className="text-xs text-ink-2">You</span>
                        ) : (
                          <button
                            type="button"
                            className={`btn btn-small ${member.isActive ? 'btn-danger' : ''}`}
                            disabled={saving !== ''}
                            onClick={() => updateUser(
                              member,
                              { isActive: !member.isActive },
                              `${member.name} ${member.isActive ? 'deactivated' : 'reactivated'}.`
                            )}
                          >
                            {member.isActive ? 'Deactivate' : 'Reactivate'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <form onSubmit={addUser} className="mt-8 rounded-[10px] border border-line p-5">
            <p className="font-semibold text-ink">Add a team member</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <label className="label block">
                Name
                <input className="field mt-2" required value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} />
              </label>
              <label className="label block">
                Email
                <input className="field mt-2" type="email" required value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
              </label>
              <label className="label block">
                Role
                <select className="field mt-2" value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                  {roles.map((role) => (
                    <option key={role.role} value={role.role}>{role.label}</option>
                  ))}
                </select>
              </label>
              <label className="label block">
                Temporary password
                <input
                  className="field mt-2"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                />
              </label>
            </div>
            <p className="mt-3 text-xs text-ink-2">
              8+ characters with upper and lower case letters and a digit. Share it securely; the person should change it after signing in.
            </p>
            <div className="mt-4 flex justify-end">
              <button type="submit" className="btn btn-primary" disabled={saving !== ''}>
                {saving === 'user' ? 'Adding...' : 'Add team member'}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
