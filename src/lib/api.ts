import { Capacitor } from '@capacitor/core';

const trimSlash = (value: string) => value.replace(/\/+$/, '');

const isNativeApp = (): boolean => {
  if (typeof window === 'undefined') return false;
  return Capacitor.isNativePlatform() || window.location.protocol === 'capacitor:' || window.location.protocol === 'ionic:';
};

export const getApiBaseUrl = (): string => {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim();
  if (configured) return trimSlash(configured);

  // Capacitor serves the bundled interface from https://localhost. That address
  // belongs to the phone itself, so native builds must use the public API URL.
  if (isNativeApp()) {
    const mobileConfigured = import.meta.env.VITE_MOBILE_API_BASE_URL?.trim();
    if (!mobileConfigured || !mobileConfigured.startsWith('https://')) {
      throw new Error('Mobil API adresi güvenli bir HTTPS URL olarak yapılandırılmamış.');
    }
    return trimSlash(mobileConfigured);
  }

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

const clientType = (): 'mobile' | 'web' => {
  return isNativeApp() ? 'mobile' : 'web';
};

export const authHeaders = (): HeadersInit => {
  const token = typeof localStorage === 'undefined' ? null : localStorage.getItem('reai_token');
  const organizationId = typeof localStorage === 'undefined' ? null : localStorage.getItem('reai_organization_id');
  return {
    'X-Client-Type': clientType(),
    ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
};

export const jsonHeaders = (): HeadersInit => ({
  'Content-Type': 'application/json',
  'X-Client-Type': clientType()
});

export function storeAuthTokens(payload: { token?: unknown; refreshToken?: unknown }): void {
  if (typeof localStorage === 'undefined') return;
  if (typeof payload.token === 'string' && payload.token) localStorage.setItem('reai_token', payload.token);
  else localStorage.removeItem('reai_token');
  if (typeof payload.refreshToken === 'string' && payload.refreshToken) {
    localStorage.setItem('reai_refresh_token', payload.refreshToken);
  }
}

export function clearAuthTokens(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem('reai_token');
  localStorage.removeItem('reai_refresh_token');
}

let refreshInFlight: Promise<boolean> | null = null;

export function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const mobileRefresh = typeof localStorage === 'undefined' ? null : localStorage.getItem('reai_refresh_token');
    const response = await fetch(getApiUrl('/api/refresh'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: mobileRefresh ? JSON.stringify({ refreshToken: mobileRefresh }) : undefined
    });
    if (!response.ok) {
      clearAuthTokens();
      return false;
    }
    const payload = await response.json().catch(() => ({}));
    if (isNativeApp()) storeAuthTokens(payload);
    return true;
  })().catch(() => {
    clearAuthTokens();
    return false;
  }).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function isRefreshEligible(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return !['/api/login', '/api/register', '/api/refresh', '/api/forgot-password', '/api/reset-password']
    .some((path) => url.includes(path));
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 401 || !isRefreshEligible(input)) return response;
  if (!await refreshAccessToken()) return response;

  const retryHeaders = new Headers(init.headers);
  const currentHeaders = new Headers(authHeaders());
  currentHeaders.forEach((value, key) => retryHeaders.set(key, value));
  return fetch(input, { ...init, headers: retryHeaders });
}
