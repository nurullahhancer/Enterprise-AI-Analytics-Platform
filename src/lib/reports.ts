import { authHeaders, getApiUrl } from './api';

export type ReportType = 'dashboard' | 'prediction' | 'quality' | 'insights';

declare global {
  interface Window {
    AndroidDownloader?: {
      download: (url: string) => void;
    };
  }
}

export async function downloadReport(type: ReportType, datasetId?: number) {
  const token = localStorage.getItem('reai_token') || '';
  const datasetParam = datasetId ? `&datasetId=${encodeURIComponent(String(datasetId))}` : '';
  const url = getApiUrl(`/reports/export/download?type=${encodeURIComponent(type)}&token=${encodeURIComponent(token)}${datasetParam}`);

  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error('Rapor indirilemedi.');

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
