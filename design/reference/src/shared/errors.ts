/**
 * Normalized, renderer-safe errors shared by the main, preload, and renderer
 * processes. Error messages are user-facing; raw causes and stack traces stay
 * in the main process.
 */

/**
 * What a failed request was, and what came back — enough to tell a dead
 * upstream apart from a wrong key or a wrong base URL without reading logs.
 *
 * Credentials are excluded by construction: every field is assembled from a
 * value the app already holds, never from the request headers, so the
 * `Authorization` header has no path into this object. See
 * `src/main/adapters/diagnostic.ts` for the builder and its two extra guards
 * (credential-shaped query parameters, and a body that echoes the key back).
 */
export interface RequestDiagnostic {
  method: string;
  url: string;
  /** Model the request asked for; absent on requests that name none. */
  model?: string;
  status?: number;
  statusText?: string;
  /** Response body, capped — see `DIAGNOSTIC_BODY_LIMIT`. */
  body?: string;
  /** True when `body` was cut at the cap. */
  bodyTruncated?: boolean;
  /** Wall-clock time from sending the request to giving up on it. */
  durationMs?: number;
}

/** Fields every error carries, whatever its type. */
interface ErrorFields {
  message: string;
  /**
   * Present whenever the failure happened on the wire. The message alone is
   * one sentence chosen by the upstream ("Connection error."); this is what
   * the user needs to act on it.
   */
  diagnostic?: RequestDiagnostic;
}

export interface NetworkError extends ErrorFields {
  type: 'network';
}

export interface TimeoutError extends ErrorFields {
  type: 'timeout';
  timeoutMs?: number;
}

export interface ProtocolError extends ErrorFields {
  type: 'protocol';
}

export interface AuthError extends ErrorFields {
  type: 'auth';
}

export interface ServerError extends ErrorFields {
  type: 'server';
  status: number;
}

export interface AbortedError extends ErrorFields {
  type: 'aborted';
}

export interface NotFoundError extends ErrorFields {
  type: 'not_found';
  resource?: string;
}

export interface ValidationError extends ErrorFields {
  type: 'validation';
  field?: string;
}

export interface InternalError extends ErrorFields {
  type: 'internal';
}

export type AppError =
  | NetworkError
  | TimeoutError
  | ProtocolError
  | AuthError
  | ServerError
  | AbortedError
  | NotFoundError
  | ValidationError
  | InternalError;

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
