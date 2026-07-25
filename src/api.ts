function getResolvedUrl(path: string): URL {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  const baseHref =
    (typeof document !== 'undefined' && (document.querySelector('base')?.href || document.baseURI)) ||
    (typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
  return new URL(normalizedPath, baseHref);
}

export function apiUrl(path: string): string {
  const url = getResolvedUrl(path);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function wsUrl(path: string, params: string): string {
  const url = getResolvedUrl(path);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.host = window.location.host;
  url.search = params ? `?${params}` : '';
  return url.toString();
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(input, {
    credentials: 'same-origin',
    ...init,
  });
  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('webssh-auth-required'));
  }
  return response;
}
