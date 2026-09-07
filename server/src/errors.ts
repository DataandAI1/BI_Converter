/**
 * Errors the API is allowed to show to callers. The global error handler exposes any
 * error carrying `expose = true` with its statusCode + message; everything else is a
 * logged, opaque 500.
 */
export class AppError extends Error {
  readonly expose = true;
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Sentinel thrown by the pipeline when a run's cancellation has been requested. */
export class RunCancelledError extends Error {
  constructor() {
    super('run cancelled by user request');
    this.name = 'RunCancelledError';
  }
}
