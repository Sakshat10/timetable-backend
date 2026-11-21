import { AppError } from './errors.js';

/**
 * Row-specific error collector for the bulk-create endpoints. Keys are request paths ("subjects.2.code",
 * "grades.0.streams.1.code") so a client can attach every message to the offending row. The shape is the same
 * `errors: Record<string, string[]>` the single-record endpoints already return.
 */
export class RowErrors {
  private readonly errors: Record<string, string[]> = {};

  add(path: string, message: string): void {
    (this.errors[path] ??= []).push(message);
  }

  get isEmpty(): boolean {
    return Object.keys(this.errors).length === 0;
  }

  /** Throws the collected errors as one AppError (nothing has been written when this is called before the transaction). */
  throwIfAny(statusCode: 400 | 409, message: string): void {
    if (!this.isEmpty) throw new AppError(statusCode, message, this.errors);
  }

  toError(statusCode: 400 | 409, message: string): AppError {
    return new AppError(statusCode, message, this.errors);
  }
}

/** Fails a request that repeats a value inside itself: every repeated row after the first points back at the first. */
export function flagInRequestDuplicates<T>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
  errors: RowErrors,
  pathOf: (index: number) => string,
  describe: (key: string, firstIndex: number) => string
): void {
  const first = new Map<string, number>();
  rows.forEach((row, index) => {
    const key = keyOf(row);
    if (key === null) return;
    const seen = first.get(key);
    if (seen === undefined) first.set(key, index);
    else errors.add(pathOf(index), describe(key, seen));
  });
}
