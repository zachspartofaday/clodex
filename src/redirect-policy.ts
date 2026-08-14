export class RedirectBlockedError extends Error {
  constructor(status: number) {
    super(`Redirect blocked (${status})`);
    this.name = 'RedirectBlockedError';
  }
}

export const fetchWithoutRedirects: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status <= 399) {
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the redirect rejection when response cleanup also fails.
    }
    throw new RedirectBlockedError(response.status);
  }
  return response;
};
