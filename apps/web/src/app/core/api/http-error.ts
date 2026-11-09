import { HttpErrorResponse } from '@angular/common/http';

export function httpErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return 'The API is not responding.';
    const body: unknown = error.error;
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.map(String).join(' ');
    }
    return error.statusText || 'Request failed.';
  }
  return 'Something went wrong.';
}
