import { useCallback, useEffect, useState } from 'react';
import * as profileService from '../../services/employeeProfileService';
import * as employeeService from '../../services/employeeService';
import { can } from '../../utils/permissions';
import { DEPARTMENTS, Dialog, FieldError, Rows, SectionHeader, apiError, formatDate, todayInput } from './shared';

const CHANGE_TYPES = [
  ['PROMOTION', 'Promotion'],
  ['REDESIGNATION', 'Redesignation'],
  ['TRANSFER', 'Transfer'],
  ['MANAGER_CHANGE', 'Manager change'],
  ['LOCATION_CHANGE', 'Work location change'],
  ['EMPLOYMENT_TYPE_CHANGE', 'Employment type change'],
  ['CONFIRMATION', 'Confirmation'],
  ['EXIT', 'Exit'],
];
const CHANGE_LABELS = { JOINING: 'Joining', ...Object.fromEntries(CHANGE_TYPES) };
const EMPLOYMENT_TYPES = [['FULL_TIME', 'Full time'], ['PART_TIME', 'Part time'], ['CONTRACT', 'Contract'], ['INTERN', 'Intern']];
const EMPLOYMENT_TYPE_LABELS = Object.fromEntries(EMPLOYMENT_TYPES);
const PROBATION_LABELS = { ON_PROBATION: 'On probation', CONFIRMED: 'Confirmed', NOT_APPLICABLE: 'Not applicable' };
const EXIT_REASONS = [
  ['RESIGNATION', 'Resignation'], ['TERMINATION', 'Termination'], ['RETIREMENT', 'Retirement'],
  ['CONTRACT_END', 'End of contract'], ['DEATH', 'Death'], ['OTHER', 'Other'],
];

const locationText = (version) =>
  [version.workLocation?.name, version.workLocation?.state].filter(Boolean).join(', ') || null;

export default function EmploymentSection({ employeeId, user, onChanged }) {
  const canWrite = can(user, 'employee.write');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showDialog, setShowDialog] = useState(false);

  const load = useCallback(() => {
    profileService
      .getEmployment(employeeId)
      .then((result) => setData(result.data))
      .catch((err) => setError(apiError(err, 'Unable to load employment history.').message));
  }, [employeeId]);

  useEffect(load, [load]);

  const current = data?.current;
  const exited = current?.lifecycleStatus === 'EXITED' || data?.scheduled?.lifecycleStatus === 'EXITED';

  return (
    <section className="panel" aria-labelledby="employment-title">
      <SectionHeader
        eyebrow="Employment"
        title="Employment history"
        id="employment-title"
        subtitle="Effective-dated. Every change adds a version; earlier versions are never edited."
      >
        {canWrite && !exited && (
          <button type="button" className="btn btn-primary" onClick={() => setShowDialog(true)}>
            Record change
          </button>
        )}
      </SectionHeader>

      {error && <div className="alert alert-danger mt-5" role="alert">{error}</div>}
      {notice && <div className="alert alert-warn mt-5" role="status">{notice}</div>}
      {data?.scheduled && (
        <div className="alert alert-warn mt-5">
          Scheduled: {CHANGE_LABELS[data.scheduled.changeType]} takes effect on {formatDate(data.scheduled.effectiveFrom)}
          {data.scheduled.exit && ` (last working day ${formatDate(data.scheduled.exit.lastWorkingDay)})`}.
        </div>
      )}

      {current && (
        <Rows
          rows={[
            ['Department', current.department],
            ['Designation', current.designation],
            ['Manager', current.manager?.name || 'None'],
            ['Work location', locationText(current)],
            ['Employment type', EMPLOYMENT_TYPE_LABELS[current.employmentType]],
            ['Probation', PROBATION_LABELS[current.probationStatus]],
            ['Status', current.lifecycleStatus === 'EXITED'
              ? `Exited · last working day ${formatDate(current.exit?.lastWorkingDay)}`
              : 'Active'],
          ]}
        />
      )}

      {data?.history?.length > 0 && (
        <div className="pg-scrollbar mt-6 overflow-x-auto">
          <table className="data-table" aria-label="Employment timeline">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Change</th>
                <th>Terms in this version</th>
                <th>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((version) => (
                <tr key={version.id}>
                  <td className="whitespace-nowrap">
                    {formatDate(version.effectiveFrom)}
                    <span className="block text-xs text-[#6F6565]">
                      {version.effectiveTo ? `until ${formatDate(version.effectiveTo)}` : 'Current'}
                    </span>
                  </td>
                  <td>
                    <span className="font-semibold text-[#241F20]">{CHANGE_LABELS[version.changeType]}</span>
                    {version.reason && version.reason !== CHANGE_LABELS[version.changeType] && (
                      <span className="block text-xs text-[#6F6565]">{version.reason}</span>
                    )}
                  </td>
                  <td className="text-sm">
                    {[
                      version.department,
                      version.designation,
                      version.manager?.name && `reports to ${version.manager.name}`,
                      locationText(version),
                      EMPLOYMENT_TYPE_LABELS[version.employmentType],
                      version.exit && `last working day ${formatDate(version.exit.lastWorkingDay)}`,
                    ].filter(Boolean).join(' · ')}
                  </td>
                  <td className="text-xs text-[#6F6565]">
                    {version.recordedByEmail || 'System'}
                    <span className="block">{formatDate(version.recordedAt)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showDialog && (
        <EmploymentChangeDialog
          employeeId={employeeId}
          onClose={() => setShowDialog(false)}
          onSaved={(result) => {
            setShowDialog(false);
            setNotice((result.warnings || []).map((warning) => warning.message).join(' '));
            load();
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function EmploymentChangeDialog({ employeeId, onClose, onSaved }) {
  const [form, setForm] = useState({
    changeType: 'PROMOTION',
    effectiveFrom: todayInput(),
    designation: '',
    department: '',
    managerEmployeeId: '',
    locationName: '',
    locationState: '',
    employmentType: 'FULL_TIME',
    lastWorkingDay: '',
    exitReason: 'RESIGNATION',
    reason: '',
  });
  const [colleagues, setColleagues] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    employeeService
      .getEmployees({ limit: 100 })
      .then((result) => setColleagues((result.data?.employees || []).filter((e) => e._id !== employeeId)))
      .catch(() => setColleagues([]));
  }, [employeeId]);

  const update = (event) => setForm((previous) => ({ ...previous, [event.target.name]: event.target.value }));
  const type = form.changeType;
  const shows = (...types) => types.includes(type);

  const payload = () => {
    const changes = {};
    if (shows('PROMOTION', 'REDESIGNATION')) changes.designation = form.designation.trim();
    if (shows('PROMOTION', 'TRANSFER') && form.department) changes.department = form.department;
    if (type === 'MANAGER_CHANGE') changes.managerEmployeeId = form.managerEmployeeId || null;
    if (type === 'TRANSFER' && form.managerEmployeeId) changes.managerEmployeeId = form.managerEmployeeId;
    if (shows('LOCATION_CHANGE', 'TRANSFER') && (form.locationName.trim() || form.locationState.trim())) {
      changes.workLocation = { name: form.locationName.trim() || null, state: form.locationState.trim() || null };
    }
    if (type === 'EMPLOYMENT_TYPE_CHANGE') changes.employmentType = form.employmentType;

    const body = { changeType: type, changes, ...(form.reason.trim() && { reason: form.reason.trim() }) };
    if (type === 'EXIT') body.exit = { lastWorkingDay: form.lastWorkingDay, reason: form.exitReason };
    else body.effectiveFrom = form.effectiveFrom;
    return body;
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await profileService.recordEmploymentChange(employeeId, payload());
      onSaved(result.data);
    } catch (err) {
      setError(apiError(err, 'The change could not be recorded.'));
      setSaving(false);
    }
  };

  return (
    <Dialog
      eyebrow="Effective-dated change"
      title="Record employment change"
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Record change"
      submitting={saving}
      wide
    >
      <p className="mt-3 text-sm leading-6 text-[#6F6565]">
        The current version closes the day before this change takes effect. Finalized payslips keep the details frozen when they were calculated.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <label className="label">
          Change
          <select name="changeType" className="field mt-2" value={type} onChange={update}>
            {CHANGE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>

        {type === 'EXIT' ? (
          <label className="label">
            Last working day
            <input name="lastWorkingDay" type="date" required className="field mt-2" value={form.lastWorkingDay} onChange={update} />
          </label>
        ) : (
          <label className="label">
            Effective from
            <input name="effectiveFrom" type="date" required max={todayInput()} className="field mt-2" value={form.effectiveFrom} onChange={update} />
          </label>
        )}

        {shows('PROMOTION', 'REDESIGNATION') && (
          <label className="label">
            New designation
            <input name="designation" required className="field mt-2" value={form.designation} onChange={update} />
          </label>
        )}

        {shows('PROMOTION', 'TRANSFER') && (
          <label className="label">
            {type === 'TRANSFER' ? 'New department' : 'Department (if it changes)'}
            <select name="department" className="field mt-2" value={form.department} onChange={update}>
              <option value="">Keep current</option>
              {DEPARTMENTS.map((department) => <option key={department} value={department}>{department}</option>)}
            </select>
          </label>
        )}

        {shows('MANAGER_CHANGE', 'TRANSFER') && (
          <label className="label">
            {type === 'MANAGER_CHANGE' ? 'Reports to' : 'Reports to (if it changes)'}
            <select name="managerEmployeeId" className="field mt-2" value={form.managerEmployeeId} onChange={update}>
              <option value="">{type === 'MANAGER_CHANGE' ? 'No manager' : 'Keep current'}</option>
              {colleagues.map((colleague) => (
                <option key={colleague._id} value={colleague._id}>
                  {colleague.firstName} {colleague.lastName} · {colleague.position}
                </option>
              ))}
            </select>
          </label>
        )}

        {shows('LOCATION_CHANGE', 'TRANSFER') && (
          <>
            <label className="label">
              Work location
              <input name="locationName" className="field mt-2" placeholder="For example: Pune office" value={form.locationName} onChange={update} />
            </label>
            <label className="label">
              State code
              <input name="locationState" className="field mt-2" placeholder="For example: MH" value={form.locationState} onChange={update} />
            </label>
          </>
        )}

        {type === 'EMPLOYMENT_TYPE_CHANGE' && (
          <label className="label">
            Employment type
            <select name="employmentType" className="field mt-2" value={form.employmentType} onChange={update}>
              {EMPLOYMENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}

        {type === 'EXIT' && (
          <label className="label">
            Exit reason
            <select name="exitReason" className="field mt-2" value={form.exitReason} onChange={update}>
              {EXIT_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}
      </div>

      {type === 'EXIT' && (
        <p className="mt-4 text-sm text-[#845B00]">
          Payroll keeps paying through the last working day and excludes the employee from periods that start after it.
        </p>
      )}

      <label className="label mt-4 block">
        Reason (recorded with the change)
        <textarea name="reason" className="field mt-2 min-h-[70px]" maxLength={500} value={form.reason} onChange={update} />
      </label>

      {error && (
        <div className="alert alert-danger mt-4" role="alert">
          {error.message}
          {Object.values(error.fields).map((message) => <FieldError key={message} message={message} />)}
        </div>
      )}
    </Dialog>
  );
}
