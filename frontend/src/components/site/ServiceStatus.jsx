import { useCallback, useEffect, useState } from 'react';
import apiClient from '../../services/api';

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });

const LABELS = {
  checking: 'Checking…',
  reachable: 'Reachable',
  unreachable: 'Not responding',
  offline: 'You are offline',
};

/**
 * Connection status of the PayGuard API (GET /health), and nothing more.
 * It is deliberately not presented as an integrity or data-freshness signal.
 */
export default function ServiceStatus() {
  const [state, setState] = useState('checking');
  const [checkedAt, setCheckedAt] = useState(null);

  const check = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setState('offline');
      setCheckedAt(new Date());
      return;
    }
    setState('checking');
    try {
      await apiClient.get('/health');
      setState('reachable');
    } catch {
      setState('unreachable');
    } finally {
      setCheckedAt(new Date());
    }
  }, []);

  useEffect(() => {
    check();
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    return () => {
      window.removeEventListener('online', check);
      window.removeEventListener('offline', check);
    };
  }, [check]);

  return (
    <div className="service-status" data-state={state}>
      <p className="service-status__line" role="status">
        <span className="service-status__dot" aria-hidden="true" />
        <span className="service-status__name">PayGuard API</span>
        <span className="service-status__value">{LABELS[state]}</span>
        {checkedAt && state !== 'checking' && (
          <span className="service-status__time">checked {timeFormat.format(checkedAt)}</span>
        )}
        {(state === 'unreachable' || state === 'offline') && (
          <button type="button" className="service-status__retry" onClick={check}>Retry</button>
        )}
      </p>
      <p className="service-status__scope">
        A connection check only. It does not verify payroll records or the audit chain.
      </p>
    </div>
  );
}
