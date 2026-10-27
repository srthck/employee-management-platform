import { useEffect, useState } from 'react';
import { apiError } from './shared';

const REASON_MIN = 10;
const VISIBLE_FOR_MS = 30000;

/**
 * Reveal one sensitive value. The reason is required and recorded in the
 * audit trail before the server returns the value; the value is kept only in
 * this dialog's state and disappears when it closes (automatically after 30s).
 */
export default function RevealDialog({ label, onReveal, onClose }) {
  const [reason, setReason] = useState('');
  const [value, setValue] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (value === null) return undefined;
    const timer = setTimeout(onClose, VISIBLE_FOR_MS);
    return () => clearTimeout(timer);
  }, [value, onClose]);

  const valid = reason.trim().length >= REASON_MIN;

  const reveal = async () => {
    setLoading(true);
    setError('');
    try {
      setValue(await onReveal(reason.trim()));
    } catch (err) {
      setError(apiError(err, 'The value could not be revealed.').message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Reveal ${label}`}>
        <p className="eyebrow">Sensitive data</p>
        <h2 className="section-title">Reveal {label}</h2>

        {value === null ? (
          <>
            <p className="mt-3 text-sm leading-6 text-ink-2">
              Your name, the time and your reason are written to the audit trail before the value is shown.
            </p>
            <label className="label mt-5 block">
              Reason
              <textarea
                className="field mt-2 min-h-[80px]"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={300}
                placeholder="For example: correcting the Form 24Q return for Q4"
              />
            </label>
            <span className="mt-1 block text-xs text-ink-2">
              {valid ? 'Recorded with the reveal.' : `At least ${REASON_MIN} characters`}
            </span>
            {error && <div className="alert alert-danger mt-4" role="alert">{error}</div>}
            <div className="mt-6 flex justify-end gap-3">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!valid || loading} onClick={reveal}>
                {loading ? 'Revealing...' : 'Reveal value'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p
              className="mt-5 rounded-[8px] border border-line bg-canvas-2 px-4 py-3 font-mono text-lg tracking-wider text-ink"
              data-testid="revealed-value"
            >
              {value}
            </p>
            <p className="mt-2 text-xs text-ink-2">
              Hidden again automatically in 30 seconds. Do not paste it into email or chat.
            </p>
            <div className="mt-6 flex justify-end">
              <button type="button" className="btn btn-primary" onClick={onClose}>Hide</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
