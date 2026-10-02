import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped context (request ID, client IP, tenant) carried through async
 * calls without threading it through every service signature.
 *
 * The audit service reads ipAddress/companyId from here so every audit event
 * emitted during an HTTP request is attributed correctly, while services that
 * run outside a request (tests, background jobs) simply see an empty context.
 */

const storage = new AsyncLocalStorage();

export const runWithContext = (context, fn) => storage.run(context, fn);

export const getContext = () => storage.getStore() || {};

export const setContextValues = (values) => {
  const store = storage.getStore();
  if (store) Object.assign(store, values);
};
