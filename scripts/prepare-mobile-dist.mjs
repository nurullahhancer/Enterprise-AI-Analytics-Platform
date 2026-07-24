import fs from 'node:fs';
import path from 'node:path';

const mobileDownloads = path.resolve(process.cwd(), 'dist', 'downloads');
const expectedParent = `${path.resolve(process.cwd(), 'dist')}${path.sep}`;

if (!mobileDownloads.startsWith(expectedParent)) {
  throw new Error('Mobil indirme dizini güvenli build kökünün dışında.');
}

fs.rmSync(mobileDownloads, { recursive: true, force: true });
console.log('Mobil paketten sunucu indirme arşivleri çıkarıldı.');
