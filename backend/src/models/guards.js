/**
 * Model-layer guards for history that must never be rewritten.
 *
 * Services are not the only code that touches the database (scripts, future
 * modules, a hurried fix). These guards make the invariants hold for every
 * write issued through Mongoose, the same approach used for payroll snapshots
 * and the audit log. Raw driver access can still bypass them; anything that
 * matters is additionally covered by audit events.
 */

const QUERY_MUTATIONS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
];

/** Reject bulk/query updates and deletes: changes must go through document saves. */
export function forbidQueryMutations(schema, makeError) {
  schema.pre(QUERY_MUTATIONS, { document: false, query: true }, function rejectQueryMutation(next) {
    next(makeError());
  });
  schema.pre('deleteOne', { document: true, query: false }, function rejectDocumentDelete(next) {
    next(makeError());
  });
}

/**
 * Let an existing document change only some top-level paths, and only while
 * `canChange(persistedState, doc)` holds (e.g. "still the current version").
 *
 * @param {import('mongoose').Schema} schema
 * @param {{
 *   allowedPaths: (doc: any) => string[],
 *   canChange: (persisted: any, doc: any) => boolean,
 *   makeError: () => Error,
 * }} options
 */
export function restrictDocumentChanges(schema, { allowedPaths, canChange, makeError }) {
  schema.post('init', function rememberPersistedState() {
    this.$locals.persisted = this.toObject({ depopulate: true, transform: false, virtuals: false });
  });

  schema.pre('save', function enforceAllowedChanges(next) {
    if (this.isNew) return next();

    const persisted = this.$locals.persisted;
    const allowed = new Set([...allowedPaths(this), 'updatedAt']);
    const changed = [...new Set(this.modifiedPaths().map((path) => path.split('.')[0]))];

    if (!persisted || !canChange(persisted, this) || changed.some((path) => !allowed.has(path))) {
      return next(makeError());
    }
    return next();
  });
}
