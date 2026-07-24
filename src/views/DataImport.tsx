import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  FileText,
  Network,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { useDropzone } from 'react-dropzone';
import { authHeaders, getApiUrl } from '../lib/api';
import { cn } from '../lib/utils';
import { User } from '../types';

interface DatasetMeta {
  id: number;
  filename: string;
  row_count: number;
  column_count: number;
  is_active: number;
  include_in_analysis: number;
  source_type: 'file' | 'json' | 'rest' | 'sql' | 'etl';
  source_ref: string | null;
  warning: string | null;
  created_at: string;
}

interface ConnectionMeta {
  id: number;
  name: string;
  type: string;
  config: string | Record<string, unknown>;
  encryptionStatus?: string;
  created_at: string;
}

interface DocumentMeta {
  id: number;
  filename: string;
  chunks_count: number;
  status: string;
  created_at: string;
}

interface AnalysisGroup {
  datasetIds: number[];
  datasetCount: number;
  selectedDatasetCount: number;
  excludedFilenames: string[];
  filename: string | null;
  rowCount: number;
  columnCount: number;
}

interface DataImportProps {
  user: User;
  onNextView?: () => void;
  onOpenEnterprise?: () => void;
}

type WorkspaceTab = 'files' | 'api';
type Notice = { type: 'success' | 'error'; text: string } | null;

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('tr-TR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const parseConnectionUrl = (config: ConnectionMeta['config']) => {
  try {
    const parsed = typeof config === 'string' ? JSON.parse(config) : config;
    if (typeof parsed?.url === 'string') return parsed.url;
    if (typeof parsed?.host === 'string') return `${parsed.host}:${parsed.port || 5432}/${parsed.database || ''}`;
    return 'Gizli bağlantı yapılandırması';
  } catch {
    return 'Gizli bağlantı yapılandırması';
  }
};

export default function DataImport({ user, onNextView, onOpenEnterprise }: DataImportProps) {
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('files');
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [analysisGroup, setAnalysisGroup] = useState<AnalysisGroup | null>(null);
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [syncingId, setSyncingId] = useState<number | null>(null);
  const [scopingId, setScopingId] = useState<number | null>(null);
  const [focusingId, setFocusingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const canWrite = user.role === 'admin' || user.role === 'analyst';
  const canManageConnections = user.role === 'admin';

  const loadSourceData = useCallback(async () => {
    setIsLoading(true);
    try {
      const headers = authHeaders();
      const [datasetResponse, analysisGroupResponse, connectionResponse, documentResponse] = await Promise.all([
        fetch(getApiUrl('/api/dataset/list'), { headers }),
        fetch(getApiUrl('/api/dataset/analysis-group'), { headers }),
        fetch(getApiUrl('/api/enterprise/connections'), { headers }),
        fetch(getApiUrl('/api/enterprise/documents'), { headers }),
      ]);

      if (!datasetResponse.ok) throw new Error('Veri kaynakları yüklenemedi.');
      setDatasets(await datasetResponse.json());
      setAnalysisGroup(analysisGroupResponse.ok ? await analysisGroupResponse.json() : null);
      setConnections(connectionResponse.ok ? await connectionResponse.json() : []);
      setDocuments(documentResponse.ok ? await documentResponse.json() : []);
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'Veri merkezi yüklenemedi.',
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSourceData();
  }, [loadSourceData]);

  const analysisDatasetIds = useMemo(() => new Set(analysisGroup?.datasetIds || []), [analysisGroup]);
  const analysisDatasets = useMemo(() => datasets.filter((dataset) => analysisDatasetIds.has(dataset.id)), [analysisDatasetIds, datasets]);
  const totalRows = Number(analysisGroup?.rowCount || 0);
  const totalColumns = Number(analysisGroup?.columnCount || 0);
  const latestUpdate = useMemo(() => {
    const timestamps = [
      ...datasets.map((item) => item.created_at),
      ...connections.map((item) => item.created_at),
      ...documents.map((item) => item.created_at),
    ].filter(Boolean);
    if (timestamps.length === 0) return 'Henüz veri yok';
    return formatDate(timestamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0]);
  }, [connections, datasets, documents]);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file || !canWrite) return;

    setIsUploading(true);
    setNotice(null);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(getApiUrl('/api/upload'), {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'Dosya yüklenemedi.');

      setNotice({
        type: 'success',
        text: `${data.filename} yüklendi ve ana dosya olarak seçildi: ${Number(data.rowCount).toLocaleString('tr-TR')} satır, ${data.columnCount} sütun.`,
      });
      await loadSourceData();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Dosya yüklenemedi.' });
    } finally {
      setIsUploading(false);
    }
  }, [canWrite, loadSourceData]);

  const handleDelete = async (dataset: DatasetMeta) => {
    if (!canWrite || !window.confirm(`"${dataset.filename}" veri setini silmek istiyor musunuz?`)) return;
    setDeletingId(dataset.id);
    setNotice(null);
    try {
      const response = await fetch(getApiUrl(`/api/dataset/${dataset.id}`), {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || 'Veri seti silinemedi.');
      setNotice({ type: 'success', text: `${dataset.filename} veri merkezinden kaldırıldı.` });
      await loadSourceData();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Veri seti silinemedi.' });
    } finally {
      setDeletingId(null);
    }
  };

  const handleSync = async (connection: ConnectionMeta) => {
    if (!canWrite || connection.encryptionStatus !== 'encrypted') return;
    setSyncingId(connection.id);
    setNotice(null);
    try {
      const response = await fetch(getApiUrl(`/api/enterprise/connections/${connection.id}/ingest`), {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || 'Veri kaynağı eşitlenemedi.');
      setNotice({
        type: 'success',
        text: `${connection.name} güncellendi. Son alınan ${Number(data.dataset?.rowCount || 0).toLocaleString('tr-TR')} satır incelemeye hazır.`,
      });
      await loadSourceData();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Veri kaynağı eşitlenemedi.' });
    } finally {
      setSyncingId(null);
    }
  };

  const handleAnalysisScope = async (dataset: DatasetMeta) => {
    if (!canWrite) return;
    const enabled = Number(dataset.include_in_analysis) !== 1;
    setScopingId(dataset.id);
    setNotice(null);
    try {
      const response = await fetch(getApiUrl(`/api/dataset/${dataset.id}/analysis-scope`), {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || 'Analiz kapsamı güncellenemedi.');
      setNotice({
        type: 'success',
        text: enabled
          ? `${dataset.filename} incelemeye eklendi.`
          : `${dataset.filename} silinmeden inceleme dışında bırakıldı.`,
      });
      await loadSourceData();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Analiz kapsamı güncellenemedi.' });
    } finally {
      setScopingId(null);
    }
  };

  const handleAnalysisFocus = async (dataset: DatasetMeta) => {
    if (!canWrite || Number(dataset.include_in_analysis) !== 1 || Number(dataset.is_active) === 1) return;
    setFocusingId(dataset.id);
    setNotice(null);
    try {
      const response = await fetch(getApiUrl(`/api/dataset/${dataset.id}/active`), {
        method: 'PUT',
        headers: authHeaders(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error?.message || 'Ana dosya değiştirilemedi.');
      setNotice({ type: 'success', text: `${dataset.filename} ana dosya yapıldı. Birlikte incelenebilen diğer dosyalar otomatik olarak eklendi.` });
      await loadSourceData();
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'Ana dosya değiştirilemedi.' });
    } finally {
      setFocusingId(null);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDragEnter: () => undefined,
    onDragLeave: () => undefined,
    onDragOver: () => undefined,
    accept: { 'text/csv': ['.csv'], 'application/json': ['.json'] },
    multiple: false,
    maxFiles: 1,
    disabled: !canWrite || isUploading,
  });

  const metrics = [
    { label: 'Birlikte İncelenen', value: analysisDatasets.length.toLocaleString('tr-TR'), helper: `${analysisGroup?.selectedDatasetCount || 0} seçili dosya içinden`, icon: Database },
    { label: 'Toplam Satır', value: totalRows.toLocaleString('tr-TR'), helper: 'İncelenecek bilgiler', icon: BarChart3 },
    { label: 'Bilgi Başlığı', value: totalColumns.toLocaleString('tr-TR'), helper: 'Toplam sütun sayısı', icon: Network },
    { label: 'Son Güncelleme', value: latestUpdate, helper: 'En son değişiklik', icon: RefreshCw },
  ];

  const flow = [
    { label: 'Veri Ekle', helper: `${datasets.length + connections.length} dosya veya bağlantı`, icon: Database, ready: datasets.length + connections.length > 0 },
    { label: 'Kontrol Et', helper: `${analysisDatasets.length} dosya hazır`, icon: ShieldCheck, ready: analysisDatasets.length > 0 },
    { label: 'Sonuçları Gör', helper: `${totalRows.toLocaleString('tr-TR')} satır`, icon: BarChart3, ready: totalRows > 0 },
    { label: 'Asistana Sor', helper: `${documents.length} ek belge`, icon: Sparkles, ready: analysisDatasets.length > 0 },
    { label: 'Tahmin Al', helper: 'Otomatik tahmin', icon: BrainCircuit, ready: totalRows >= 3 },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 p-4 pb-6 md:p-8 lg:p-10">
      <header className="relative flex flex-col gap-5 overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-[#151515] md:p-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl dark:bg-[#FFD700]/10" aria-hidden="true" />
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-indigo-600 dark:text-[#FFD700]">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Verileriniz kullanıma hazır
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-950 dark:text-white md:text-5xl">Verilerim</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 dark:text-white/55">
            Satış, müşteri veya iş dosyalarınızı yükleyin. Birlikte incelenebilen dosyalar otomatik olarak bir araya getirilir; diğer dosyalarınız silinmeden ayrı tutulur.
          </p>
        </div>
        <div className="relative flex flex-wrap gap-2">
          {onOpenEnterprise && canManageConnections && (
            <button
              type="button"
              onClick={onOpenEnterprise}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
            >
              <ShieldCheck className="h-4 w-4" />
              Yeni Veri Kaynağı Bağla
            </button>
          )}
          {onNextView && (
            <button
              type="button"
              onClick={onNextView}
              disabled={analysisDatasets.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe24d]"
            >
              Sonuçları Gör
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metrics.map((metric) => (
          <div
            key={metric.label}
            className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-white/[0.045] md:p-5"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-white/40">{metric.label}</p>
              <metric.icon className="h-4 w-4 text-indigo-500 dark:text-[#FFD700]" />
            </div>
            <p className="mt-3 truncate text-2xl font-bold text-slate-950 dark:text-white">{metric.value}</p>
            <p className="mt-1 text-xs text-slate-400 dark:text-white/35">{metric.helper}</p>
          </div>
        ))}
      </section>

      <section className="border-y border-slate-200 py-5 dark:border-white/10">
        <div className="grid grid-cols-2 gap-px overflow-hidden border border-slate-200 bg-slate-200 dark:border-white/10 dark:bg-white/10 md:grid-cols-5">
          {flow.map((step, index) => (
            <div key={step.label} className="relative flex min-h-24 items-center gap-3 bg-white px-4 py-4 dark:bg-[#151515]">
              <div className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                step.ready
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : 'border-slate-200 bg-slate-50 text-slate-400 dark:border-white/10 dark:bg-white/5 dark:text-white/35',
              )}>
                <step.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-slate-400 dark:text-white/30">0{index + 1}</span>
                  <p className="text-xs font-bold text-slate-800 dark:text-white">{step.label}</p>
                </div>
                <p className="mt-1 truncate text-[11px] text-slate-400 dark:text-white/35">{step.helper}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {notice && (
        <div
          role="status"
          className={cn(
            'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm font-medium',
            notice.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300',
          )}
        >
          {notice.type === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          {notice.text}
        </div>
      )}

      {!canWrite && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          Viewer rolüyle veri kaynaklarını görüntüleyebilirsiniz; yükleme, eşitleme ve silme işlemleri kapalıdır.
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-white/10" role="tablist" aria-label="Veri kaynağı türü">
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === 'files'}
          onClick={() => setWorkspaceTab('files')}
          className={cn(
            'flex items-center gap-2 border-b-2 px-4 py-3 text-xs font-bold transition-colors',
            workspaceTab === 'files'
              ? 'border-indigo-600 text-indigo-600 dark:border-[#FFD700] dark:text-[#FFD700]'
              : 'border-transparent text-slate-400 hover:text-slate-700 dark:hover:text-white',
          )}
        >
          <FileSpreadsheet className="h-4 w-4" />
          Yüklediğim Dosyalar
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-white/10 dark:text-white/50">{datasets.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workspaceTab === 'api'}
          onClick={() => setWorkspaceTab('api')}
          className={cn(
            'flex items-center gap-2 border-b-2 px-4 py-3 text-xs font-bold transition-colors',
            workspaceTab === 'api'
              ? 'border-indigo-600 text-indigo-600 dark:border-[#FFD700] dark:text-[#FFD700]'
              : 'border-transparent text-slate-400 hover:text-slate-700 dark:hover:text-white',
          )}
        >
          <Network className="h-4 w-4" />
          Bağlı Sistemler
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-white/10 dark:text-white/50">{connections.length}</span>
        </button>
      </div>

      {workspaceTab === 'files' ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="min-w-0">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">İncelenecek dosyalar</h2>
                <p className="mt-1 text-xs text-slate-500 dark:text-white/45">Ana dosyayla benzer başlıklara sahip dosyalar birlikte incelenir. Farklı bilgiler içeren dosyalarınız ayrı ve güvenli biçimde saklanır.</p>
              </div>
              {isLoading && <RefreshCw className="h-4 w-4 animate-spin text-slate-400" />}
            </div>

            <div className="overflow-hidden border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035]">
              {isLoading ? (
                <div className="p-10 text-center text-xs font-bold uppercase tracking-widest text-slate-400">Kaynaklar yükleniyor</div>
              ) : datasets.length === 0 ? (
                <div className="p-10 text-center">
                  <FileSpreadsheet className="mx-auto h-8 w-8 text-slate-300 dark:text-white/25" />
                  <p className="mt-3 text-sm font-bold text-slate-700 dark:text-white">Analiz havuzu boş</p>
                  <p className="mt-1 text-xs text-slate-400 dark:text-white/40">CSV/JSON yükleyin veya REST kaynağından veri eşitleyin.</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-white/10">
                  {datasets.map((dataset) => {
                    const fromApi = dataset.source_type === 'rest' || dataset.filename.endsWith('_ingest.csv');
                    const sourceLabel = dataset.source_type === 'sql' ? 'SQL' : fromApi ? 'REST' : dataset.source_type === 'json' ? 'JSON' : dataset.source_type === 'etl' ? 'ETL' : 'CSV';
                    const included = Number(dataset.include_in_analysis) === 1;
                    const inCurrentGroup = analysisDatasetIds.has(dataset.id);
                    const isFocus = Number(dataset.is_active) === 1;
                    return (
                      <div key={dataset.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className={cn(
                            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border',
                            fromApi
                              ? 'border-sky-200 bg-sky-50 text-sky-600 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-400'
                              : 'border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/10 dark:text-[#FFD700]',
                          )}>
                            {fromApi ? <Network className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm font-bold text-slate-800 dark:text-white">{dataset.filename}</p>
                              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold uppercase text-slate-500 dark:bg-white/10 dark:text-white/45">
                                {sourceLabel}
                              </span>
                              <span className={cn(
                                'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase',
                                inCurrentGroup
                                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                                  : included
                                    ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
                                  : 'bg-slate-100 text-slate-500 dark:bg-white/10 dark:text-white/40',
                              )}>
                                {inCurrentGroup ? 'Birlikte İnceleniyor' : included ? 'Ayrı İncelenecek' : 'İnceleme Dışı'}
                              </span>
                              {isFocus && (
                                <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] font-bold uppercase text-indigo-600 dark:bg-[#FFD700]/10 dark:text-[#FFD700]">
                                  Ana Dosya
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-[11px] text-slate-400 dark:text-white/35">
                              {Number(dataset.row_count).toLocaleString('tr-TR')} satır · {dataset.column_count} kolon · {formatDate(dataset.created_at)}
                            </p>
                            {dataset.warning && <p className="mt-1 text-[11px] text-amber-500">{dataset.warning}</p>}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          {included && !isFocus && (
                            <button
                              type="button"
                              onClick={() => void handleAnalysisFocus(dataset)}
                              disabled={!canWrite || focusingId === dataset.id}
                              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-indigo-200 px-3 text-[10px] font-bold uppercase tracking-wide text-indigo-600 transition-colors hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-30 dark:border-[#FFD700]/20 dark:text-[#FFD700] dark:hover:bg-[#FFD700]/10 sm:min-h-9 sm:flex-none"
                            >
                              {focusingId === dataset.id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
                              Ana Dosya Yap
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void handleAnalysisScope(dataset)}
                            disabled={!canWrite || scopingId === dataset.id}
                            className={cn(
                              'inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border px-3 text-[10px] font-bold uppercase tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-30 sm:min-h-9 sm:flex-none',
                              included
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
                                : 'border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-white/15 dark:text-white/60 dark:hover:bg-white/5',
                            )}
                          >
                            {scopingId === dataset.id ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            {included ? 'İnceleme Dışı Bırak' : 'İncelemeye Ekle'}
                          </button>
                          <button
                            type="button"
                            title="Veri setini sil"
                            aria-label={`${dataset.filename} veri setini sil`}
                            onClick={() => void handleDelete(dataset)}
                            disabled={!canWrite || deletingId === dataset.id}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-red-200 text-red-500 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30 dark:border-red-500/20 dark:hover:bg-red-500/10 sm:h-9 sm:w-9"
                          >
                            {deletingId === dataset.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <aside className="min-w-0">
            <div className="mb-4">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Dosya yükle</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-white/45">CSV veya JSON · dosya boyutu sınırı yok</p>
            </div>
            <div
              {...getRootProps()}
              className={cn(
                'flex min-h-64 flex-col items-center justify-center border-2 border-dashed p-7 text-center transition-colors',
                isDragActive
                  ? 'border-indigo-500 bg-indigo-50 dark:border-[#FFD700] dark:bg-[#FFD700]/10'
                  : 'border-slate-300 bg-white hover:border-indigo-400 dark:border-white/15 dark:bg-white/[0.035] dark:hover:border-[#FFD700]/60',
                (!canWrite || isUploading) && 'cursor-not-allowed opacity-55',
                canWrite && !isUploading && 'cursor-pointer',
              )}
            >
              <input {...getInputProps()} />
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-[#FFD700]/10 dark:text-[#FFD700]">
                {isUploading ? <RefreshCw className="h-5 w-5 animate-spin" /> : <UploadCloud className="h-5 w-5" />}
              </div>
              <p className="mt-4 text-sm font-bold text-slate-800 dark:text-white">
                {isUploading ? 'Dosya işleniyor' : isDragActive ? 'Dosyayı bırakın' : 'CSV veya JSON dosyasını sürükleyin'}
              </p>
              <p className="mt-2 text-xs leading-5 text-slate-400 dark:text-white/35">veya cihazınızdan güvenli bir veri dosyası seçin</p>
              <span className="mt-5 inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-600 dark:border-white/15 dark:text-white/70">
                <Plus className="h-4 w-4" />
                Dosya Seç
              </span>
            </div>
          </aside>
        </div>
      ) : (
        <section>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">Bağlı sistemler</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-white/45">Satış veya iş sistemlerinizden gelen güncel verileri buradan alabilirsiniz.</p>
            </div>
            {onOpenEnterprise && (
              <button
                type="button"
                onClick={onOpenEnterprise}
                disabled={!canManageConnections}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:bg-white/5 dark:text-white dark:hover:bg-white/10"
              >
                <Plus className="h-4 w-4" />
                Yeni Sistem Bağla
              </button>
            )}
          </div>

          <div className="overflow-hidden border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035]">
            {isLoading ? (
              <div className="p-10 text-center text-xs font-bold uppercase tracking-widest text-slate-400">Bağlantılar yükleniyor</div>
            ) : connections.length === 0 ? (
              <div className="p-10 text-center">
                <Network className="mx-auto h-8 w-8 text-slate-300 dark:text-white/25" />
                <p className="mt-3 text-sm font-bold text-slate-700 dark:text-white">Tanımlı REST kaynağı yok</p>
                <p className="mt-1 text-xs text-slate-400 dark:text-white/40">Yönetici rolüyle güvenli bir REST bağlantısı tanımlayabilirsiniz.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-white/10">
                {connections.map((connection) => {
                  const canSync = canWrite && connection.encryptionStatus === 'encrypted';
                  return (
                    <div key={connection.id} className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-sky-200 bg-sky-50 text-sky-600 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-400">
                          <Network className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-bold text-slate-800 dark:text-white">{connection.name}</p>
                            <span className={cn(
                              'rounded px-1.5 py-0.5 text-[9px] font-bold uppercase',
                              connection.encryptionStatus === 'encrypted'
                                ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                                : 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
                            )}>
                              {connection.encryptionStatus === 'encrypted' ? 'Güvenli' : 'Yapılandırma gerekli'}
                            </span>
                          </div>
                          <p className="mt-1 max-w-2xl truncate text-[11px] text-slate-400 dark:text-white/35">{parseConnectionUrl(connection.config)}</p>
                          <p className="mt-1 text-[10px] text-slate-400 dark:text-white/30">Oluşturulma: {formatDate(connection.created_at)}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleSync(connection)}
                        disabled={!canSync || syncingId === connection.id}
                        className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-35 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe24d]"
                      >
                        <RefreshCw className={cn('h-4 w-4', syncingId === connection.id && 'animate-spin')} />
                        {syncingId === connection.id ? 'Eşitleniyor' : 'Şimdi Eşitle'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-6 grid grid-cols-1 border border-slate-200 bg-white dark:border-white/10 dark:bg-white/[0.035] md:grid-cols-2">
            <div className="flex items-start gap-3 p-5 md:border-r md:border-slate-200 md:dark:border-white/10">
              <FileText className="mt-0.5 h-5 w-5 text-fuchsia-500" />
              <div>
                <p className="text-sm font-bold text-slate-800 dark:text-white">AI bilgi havuzu</p>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-white/45">{documents.length} PDF/TXT dokümanı, yapay zekâ yanıtlarında kurumsal bağlam olarak kullanılmaya hazır.</p>
              </div>
            </div>
            <div className="flex items-start gap-3 border-t border-slate-200 p-5 dark:border-white/10 md:border-t-0">
              <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-500" />
              <div>
                <p className="text-sm font-bold text-slate-800 dark:text-white">Kaynak güvenliği</p>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-white/45">Bağlantı sırları şifrelenir; dış REST erişimi yalnızca izinli HTTPS adresleriyle sınırlandırılır.</p>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
