import { authHeaders, getApiUrl } from './api';

export type ReportType = 'dashboard' | 'prediction' | 'quality' | 'insights';

export async function downloadReport(type: ReportType) {
  const url = getApiUrl(`/reports/download?type=${encodeURIComponent(type)}`);

  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) {
    let message = 'Rapor indirilemedi.';
    try {
      const payload = await response.json();
      message = payload.error?.message || message;
    } catch {
      // The download endpoint may return a non-JSON proxy error.
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);

  const link = document.createElement('a');
  const disposition = response.headers.get('content-disposition');
  const fileName = disposition?.match(/filename="([^"]+)"/)?.[1] || `${type}-rapor.csv`;
  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
