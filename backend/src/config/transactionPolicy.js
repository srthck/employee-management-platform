/**
 * Transaction policy — may payroll and audit writes run WITHOUT multi-document transactions?
 *
 * The answer is "no" unless two independent boundaries both say "yes":
 *
 *   1. the process says so explicitly:   REQUIRE_TRANSACTIONS=false, and NODE_ENV is EXACTLY "development" or
 *      "test". An unset, misspelled or unfamiliar NODE_ENV ("staging", "Production", "prod", "productoin") is
 *      never trusted to enable a fallback; it is treated as strict, like production.
 *   2. the database says so:             every host of MONGO_URI is a loopback address (localhost, 127.0.0.0/8,
 *      ::1). A remote database, an SRV record or an unparseable URI never gets the fallback, whatever
 *      NODE_ENV claims. NODE_ENV alone is a label anyone can mistype; it is not an authorization boundary.
 *
 * Pure function: no I/O, no process state, so every combination can be tested exhaustively.
 */

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** Hosts named in a mongodb:// URI (credentials, ports and options removed); null when they cannot be established. */
export function mongoHosts(uri) {
  if (typeof uri !== 'string') return null;
  const match = /^mongodb(\+srv)?:\/\/(.*)$/i.exec(uri.trim());
  if (!match || match[1]) return null; // not a mongodb:// URI, or an SRV record (hosts unknown until DNS)
  let authority = match[2];
  const end = authority.search(/[/?]/);
  if (end >= 0) authority = authority.slice(0, end);
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  if (!authority) return null;
  const hosts = authority.split(',').map((entry) => {
    const host = entry.trim().toLowerCase();
    if (host.startsWith('[')) return host.slice(1, Math.max(1, host.indexOf(']')));
    return host.replace(/:\d+$/, '');
  });
  return hosts.every(Boolean) ? hosts : null;
}

export const isLoopbackHost = (host) => host === 'localhost' || host === '::1' || LOOPBACK_V4.test(host);

export function isLoopbackOnlyUri(uri) {
  const hosts = mongoHosts(uri);
  return Boolean(hosts && hosts.length > 0 && hosts.every(isLoopbackHost));
}

const ENVIRONMENT_CLASSES = { production: 'production', development: 'development', test: 'test' };

/**
 * @param {{ nodeEnv?: string, requireTransactionsFlag?: string, mongoUri?: string }} input raw values, exactly as found
 * @returns {{ environmentClass: string, requireTransactions: boolean, optOutRequested: boolean, optOutHonoured: boolean, notes: string[] }}
 */
export function resolveTransactionPolicy({ nodeEnv, requireTransactionsFlag, mongoUri } = {}) {
  const environmentClass = Object.hasOwn(ENVIRONMENT_CLASSES, nodeEnv ?? '') ? ENVIRONMENT_CLASSES[nodeEnv] : 'unrecognized';
  const optOutRequested = requireTransactionsFlag === 'false';
  const notes = [];
  let optOutHonoured = false;

  if (environmentClass === 'unrecognized') {
    notes.push(`NODE_ENV ${JSON.stringify(nodeEnv ?? null)} is not exactly "production", "development" or "test": treated as strict (transactions required).`);
  }
  if (optOutRequested) {
    if (environmentClass !== 'development' && environmentClass !== 'test') {
      notes.push(`REQUIRE_TRANSACTIONS=false ignored: NODE_ENV ${JSON.stringify(nodeEnv ?? null)} is not exactly "development" or "test".`);
    } else if (!isLoopbackOnlyUri(mongoUri)) {
      notes.push('REQUIRE_TRANSACTIONS=false ignored: the database URI is not loopback-only (localhost, 127.0.0.0/8, ::1).');
    } else {
      optOutHonoured = true;
      notes.push('REQUIRE_TRANSACTIONS=false honoured: development/test against a loopback database. Writes are NOT atomic on a standalone server.');
    }
  }
  return Object.freeze({ environmentClass, requireTransactions: !optOutHonoured, optOutRequested, optOutHonoured, notes: Object.freeze(notes) });
}
