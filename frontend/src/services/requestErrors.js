/**
 * A user-facing message for a failed API request.
 *
 * Without a response the browser cannot say why: the server may be down, or it
 * refused this page's origin (CORS), which the browser reports the same way.
 * Say so instead of a generic "please try again", which hides both causes.
 */
export function requestErrorMessage(err, fallback) {
  if (!err?.response) {
    if (err?.code === 'ECONNABORTED') {
      return 'The PayGuard server took too long to respond. Please try again.';
    }
    return `Cannot reach the PayGuard server from ${window.location.origin}. `
      + 'Check that the backend is running and that you opened PayGuard at its usual address.';
  }
  return err.response.data?.message || fallback;
}
