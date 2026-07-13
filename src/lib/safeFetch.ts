import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224;
  }

  const normalized = address.toLowerCase().split('%')[0];
  return normalized === '::' || normalized === '::1' ||
    normalized.startsWith('fc') || normalized.startsWith('fd') ||
    normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
    normalized.startsWith('fea') || normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:');
}

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.REST_CONNECTOR_ALLOWED_HOSTS || '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function validateUrl(rawUrl: string): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Geçerli bir REST endpoint adresi girin.');
  }

  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:')) {
    throw new Error('REST bağlantıları production ortamında HTTPS kullanmalıdır.');
  }
  if (url.username || url.password) throw new Error('URL içinde kullanıcı adı veya parola kullanılamaz.');

  const host = url.hostname.toLowerCase();
  const allowlist = allowedHosts();
  if (allowlist.size === 0 || !allowlist.has(host)) {
    throw new Error('Bu REST hostu sunucu izin listesinde değil.');
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Özel ağ adreslerine bağlantı kurulamaz.');
  }

  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('REST hostu güvenli olmayan bir ağ adresine çözümleniyor.');
  }
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export async function fetchPublicJson(rawUrl: string): Promise<unknown> {
  const { url, address, family } = await validateUrl(rawUrl);
  const transport = url.protocol === 'https:' ? https : http;

  const text = await new Promise<string>((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address, family)
    }, (response) => {
      const remoteAddress = response.socket.remoteAddress || '';
      if (!remoteAddress || isPrivateAddress(remoteAddress)) {
        response.destroy();
        return reject(new Error('REST bağlantısı güvenli olmayan bir ağ adresine yönlendi.'));
      }
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
        response.resume();
        return reject(new Error('REST yönlendirmeleri güvenlik nedeniyle desteklenmiyor.'));
      }
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        response.resume();
        return reject(new Error(`REST servisi HTTP ${response.statusCode ?? 500} döndürdü.`));
      }

      const contentType = String(response.headers['content-type'] || '');
      if (!contentType.toLowerCase().includes('json')) {
        response.resume();
        return reject(new Error('REST servisi JSON döndürmedi.'));
      }
      const advertisedLength = Number(response.headers['content-length'] || 0);
      if (advertisedLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        return reject(new Error('REST yanıtı izin verilen boyutu aşıyor.'));
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('REST yanıtı izin verilen boyutu aşıyor.'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });

    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('REST isteği zaman aşımına uğradı.')));
    request.on('error', reject);
    request.end();
  });

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('REST servisi geçersiz JSON döndürdü.');
  }
}
