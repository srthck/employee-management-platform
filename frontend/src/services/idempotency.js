import axiosInstance from './axiosInstance';

/**
 * Idempotent POST: one key per user action, reused on automatic retries.
 *
 * If the network drops or times out before the response arrives, the request
 * may or may not have been executed. Retrying with the SAME Idempotency-Key is
 * safe: the server replays the original result instead of acting twice.
 * A 409 IDEMPOTENCY_REQUEST_IN_PROGRESS means the first attempt is still
 * running; wait and ask again with the same key.
 */

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

export const newIdempotencyKey = () =>
  (window.crypto?.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const retryable = (error) =>
  !error.response ||
  error.code === 'ECONNABORTED' ||
  error.response?.data?.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS';

export async function postIdempotent(url, body = {}, config = {}) {
  const key = newIdempotencyKey();
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axiosInstance.post(url, body, {
        ...config,
        headers: { ...(config.headers || {}), 'Idempotency-Key': key },
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS || !retryable(error)) throw error;
      await wait(RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}
