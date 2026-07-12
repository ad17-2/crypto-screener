export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Records a ProviderError into `errors` (optionally labelled); rethrows anything else. */
export function collectProviderError(errors: string[], error: unknown, label?: string): void {
  if (error instanceof ProviderError) {
    errors.push(label ? `${label}: ${error.message}` : error.message);
  } else {
    throw error;
  }
}
