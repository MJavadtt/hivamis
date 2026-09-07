/** Application error carrying an HTTP status, a stable machine code and a Persian user message. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly messageFa: string,
    readonly details?: unknown,
  ) {
    super(messageFa);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, fa: string, details?: unknown) =>
  new AppError(400, code, fa, details);
export const unauthorized = (fa = 'احراز هویت لازم است') =>
  new AppError(401, 'UNAUTHORIZED', fa);
export const forbidden = (fa = 'دسترسی لازم را ندارید') =>
  new AppError(403, 'FORBIDDEN', fa);
export const notFound = (what = 'رکورد') =>
  new AppError(404, 'NOT_FOUND', `${what} یافت نشد`);
export const conflict = (code: string, fa: string, details?: unknown) =>
  new AppError(409, code, fa, details);

/**
 * Raised when a Doc_H governance rule blocks an operation.
 * `rule` identifies the clause so the UI can explain exactly which rule fired.
 */
export class GovernanceError extends AppError {
  constructor(readonly rule: string, messageFa: string, details?: unknown) {
    super(422, 'GOVERNANCE_RULE_VIOLATION', messageFa, { rule, ...(details as object ?? {}) });
    this.name = 'GovernanceError';
  }
}
