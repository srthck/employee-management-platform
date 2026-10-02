/**
 * Error envelope: every failed JSON response carries a machine-readable
 * `code` and the request ID, whichever layer produced it (validators, rate
 * limiters, controllers, the error handler).
 *
 *   { "success": false, "code": "NOT_FOUND", "message": "...", "requestId": "..." }
 *
 * Specific codes set by the producer (e.g. VARIANCE_UNEXPLAINED) are kept;
 * otherwise a stable default is derived from the HTTP status. Clients branch on
 * `code`, never on message text.
 */

const DEFAULT_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE',
  428: 'PRECONDITION_REQUIRED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export const errorCodeForStatus = (status) =>
  DEFAULT_CODES[status] || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED');

export const errorEnvelope = (req, res, next) => {
  const sendJson = res.json.bind(res);

  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body) && body.success === false) {
      const code = body.code
        || (body.message === 'Validation failed' ? 'VALIDATION_FAILED' : errorCodeForStatus(res.statusCode));
      return sendJson({ ...body, code, requestId: body.requestId || req.requestId });
    }
    return sendJson(body);
  };

  next();
};
