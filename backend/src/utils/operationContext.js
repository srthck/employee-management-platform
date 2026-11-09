import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The logical operation (one Idempotency-Key) a request is executing, if any.
 * runInTransaction reads it so that every transaction of the request records
 * itself on the operation's durable record, in that same transaction.
 */
const operationStorage = new AsyncLocalStorage();

export const runWithOperation = (operation, fn) => operationStorage.run(operation, fn);
export const currentOperation = () => operationStorage.getStore();
