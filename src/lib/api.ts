const trimSlash = (value: string) => value.replace(/\/+$/, '');

export const getApiBaseUrl = (): string => {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) return trimSlash(configured);

  if (typeof window !== 'undefined') {
    if (window.location.origin && window.location.origin !== 'null') {
      return trimSlash(window.location.origin);
    }
  }

  return 'http://localhost:3010';
};

export const getApiUrl = (path: string): string => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
};

export const authHeaders = (): HeadersInit => {
  const token = typeof localStorage === 'undefined' ? null : localStorage.getItem('reai_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const jsonHeaders = (): HeadersInit => ({
  'Content-Type': 'application/json'
});
