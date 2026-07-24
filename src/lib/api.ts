import { Capacitor } from '@capacitor/core';

const trimSlash = (value: string) => value.replace(/\/+$/, '');
const DEFAULT_MOBILE_API_BASE_URL = 'https://45.133.36.77';

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
    return trimSlash(mobileConfigured || DEFAULT_MOBILE_API_BASE_URL);
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
