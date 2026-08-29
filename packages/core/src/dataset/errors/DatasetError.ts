import { DomainError } from "./DomainError.js";
import {
  ValidationIssue,
  ValidationResult,
  ValidationSeverity,
} from "../interfaces/DatasetValidator.js";

export class InvalidDatasetError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_DATASET");
  }
}

export class InvalidDocumentError extends DomainError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "INVALID_DOCUMENT");
    if (options?.cause !== undefined) {
      // Capture the original error so stack traces are preserved for debugging.
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}

export class DatasetValidationError extends DomainError {
  public readonly errors: readonly string[];
  public readonly issues: readonly ValidationIssue[];
  public readonly result?: ValidationResult;

  constructor(
    message: string,
    errors: readonly string[] = [],
    issues: readonly ValidationIssue[] = [],
    result?: ValidationResult,
  ) {
    super(message, "DATASET_VALIDATION_ERROR");
    this.errors = Object.freeze([...errors]);
    this.issues = Object.freeze([...issues]);
    this.result = result;
  }

  public static fromResult(
    result: ValidationResult,
    customMessage?: string,
  ): DatasetValidationError {
    const errorIssues = result.issues.filter((i) => i.severity === ValidationSeverity.ERROR);
    const errorCount = errorIssues.length > 0 ? errorIssues.length : result.errors.length;
    const uniqueErrorDetails = Array.from(
      new Set(result.errors.length > 0 ? result.errors : errorIssues.map((i) => i.message)),
    );
    const errorSuffix = uniqueErrorDetails.length > 0 ? `: ${uniqueErrorDetails.join("; ")}` : "";
    const message =
      customMessage ??
      `Dataset validation failed with ${errorCount} error${errorCount === 1 ? "" : "s"}${errorSuffix}`;
    return new DatasetValidationError(message, result.errors, result.issues, result);
  }
}

export class DuplicateDocumentError extends DomainError {
  constructor(documentId: string) {
    super(`Document with ID "${documentId}" already exists in dataset`, "DUPLICATE_DOCUMENT");
  }
}

export class UnsupportedSourceError extends DomainError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "UNSUPPORTED_SOURCE");
    if (options?.cause !== undefined) {
      // Capture the original error so stack traces and error codes are
      // preserved for debugging (e.g. filesystem ENOENT / EACCES errors).
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}
