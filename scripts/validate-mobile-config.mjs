const rawUrl = process.env.VITE_MOBILE_API_BASE_URL?.trim();

if (!rawUrl) {
  throw new Error('VITE_MOBILE_API_BASE_URL mobil build için zorunludur.');
}

let apiUrl;
try {
  apiUrl = new URL(rawUrl);
} catch {
  throw new Error('VITE_MOBILE_API_BASE_URL geçerli bir URL olmalıdır.');
}

if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password || apiUrl.hash) {
  throw new Error('VITE_MOBILE_API_BASE_URL kullanıcı bilgisi veya fragment içermeyen bir HTTPS URL olmalıdır.');
}

if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(apiUrl.hostname.toLowerCase())) {
  throw new Error('Mobil production build localhost API adresi kullanamaz.');
}

console.log(`Mobil API hedefi doğrulandı: ${apiUrl.origin}`);
