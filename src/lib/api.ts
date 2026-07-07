const trimSlash = (value: string) => value.replace(/\/+$/, '');

const tunnelHeaders = (): HeadersInit => ({
  'ngrok-skip-browser-warning': 'true'
});

export const getApiBaseUrl = (): string => {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes('android')) return 'http://10.0.2.2:3010';

  if (typeof window !== 'undefined' && window.location.origin) {
    return trimSlash(window.location.origin);
  }

  const configured = import.meta.env.VITE_API_BASE_URL;
  if (configured) return trimSlash(configured);

  return 'http://localhost:3010';
};

export const getApiUrl = (path: string): string => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getApiBaseUrl()}${normalizedPath}`;
};

export const authHeaders = (): HeadersInit => {
  const token = localStorage.getItem('reai_token');
  return token ? { ...tunnelHeaders(), Authorization: `Bearer ${token}` } : tunnelHeaders();
};

export const jsonHeaders = (): HeadersInit => ({
  ...tunnelHeaders(),
  'Content-Type': 'application/json'
});
