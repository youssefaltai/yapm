export type ServiceErrorCode = "BAD_REQUEST" | "NOT_FOUND" | "FORBIDDEN" | "CONFLICT";

/** A rejected operation, reported to API callers with its code. */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new ServiceError("BAD_REQUEST", message);
export const notFound = (what: string) => new ServiceError("NOT_FOUND", `${what} not found`);
export const forbidden = (message: string) => new ServiceError("FORBIDDEN", message);
