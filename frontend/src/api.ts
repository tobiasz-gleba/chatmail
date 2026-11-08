export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly requestId?: string,
  ) { super(message) }
}

export async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    if (response.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event('chatmail:session-expired'))
    }
    throw new ApiError(detail?.error?.message ?? 'The request could not be completed.',
      detail?.error?.code ?? 'REQUEST_FAILED', response.status, detail?.requestId)
  }
  return response.json() as Promise<T>
}
