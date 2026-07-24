import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BarChart3,
  BellRing,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import { cn } from '../lib/utils';
import type { User } from '../types';

type Aggregation = 'sum' | 'average' | 'min' | 'max' | 'count';
type DisplayFormat = 'number' | 'currency' | 'percent';
type ThresholdType = 'none' | 'minimum' | 'maximum';
type KpiStatus = 'healthy' | 'breach' | 'unavailable';
type JsonRecord = Record<string, unknown>;

interface DatasetSummary {
  filename: string;
  rowCount: number;
}

interface NumericColumn {
  name: string;
  nonEmptyCount: number;
}

interface ColumnsResponse {
  dataset: DatasetSummary | null;
  allColumns: string[];
  numericColumns: NumericColumn[];
}

interface KpiEvaluation {
  id: string;
  value: number | null;
  status: KpiStatus;
  rowCount: number;
  message: string;
  evaluatedAt: string;
}

interface KpiDefinition {
  id: string;
  name: string;
  description: string;
  columnName: string;
  aggregation: Aggregation;
  displayFormat: DisplayFormat;
  thresholdType: ThresholdType;
  thresholdValue: number | null;
  enabled: boolean;
  latest: KpiEvaluation | null;
  createdAt: string;
  updatedAt: string;
}

interface DecisionCenterProps {
  user: User;
}

interface KpiFormState {
  name: string;
  description: string;
  columnName: string;
  aggregation: Aggregation;
  displayFormat: DisplayFormat;
  thresholdType: ThresholdType;
  thresholdValue: string;
  enabled: boolean;
}

type FormErrors = Partial<Record<keyof KpiFormState, string>>;
type Notice = { type: 'success' | 'error'; text: string } | null;

const EMPTY_FORM: KpiFormState = {
  name: '',
  description: '',
  columnName: '',
  aggregation: 'sum',
  displayFormat: 'number',
  thresholdType: 'none',
  thresholdValue: '',
  enabled: true,
};

const AGGREGATION_LABELS: Record<Aggregation, string> = {
  sum: 'Toplam',
  average: 'Ortalama',
  min: 'En düşük',
  max: 'En yüksek',
  count: 'Dolu kayıt sayısı',
};

const DISPLAY_LABELS: Record<DisplayFormat, string> = {
  number: 'Sayı',
  currency: 'Para (TRY)',
  percent: 'Yüzde',
};

const THRESHOLD_LABELS: Record<ThresholdType, string> = {
  none: 'Uyarı eşiği yok',
  minimum: 'Altına düşerse uyar',
  maximum: 'Üstüne çıkarsa uyar',
};

const STATUS_CONTENT: Record<KpiStatus, { label: string; card: string; badge: string }> = {
  healthy: {
    label: 'Normal',
    card: 'border-emerald-200/80 dark:border-emerald-500/20',
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300',
  },
  breach: {
    label: 'Eşik ihlali',
    card: 'border-red-300/80 dark:border-red-500/30',
    badge: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300',
  },
  unavailable: {
    label: 'Veri yok',
    card: 'border-amber-200/80 dark:border-amber-500/25',
    badge: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300',
  },
};

const inputClassName = 'w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/15 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 dark:border-white/10 dark:bg-black/25 dark:text-white dark:placeholder:text-white/30 dark:focus:border-[#FFD700]/70 dark:focus:ring-[#FFD700]/10 dark:disabled:bg-white/5 dark:disabled:text-white/30';

const isRecord = (value: unknown): value is JsonRecord => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const textValue = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const nonNegativeInteger = (value: unknown): number => {
  const parsed = finiteNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed));
};

const isAggregation = (value: unknown): value is Aggregation => (
  value === 'sum' || value === 'average' || value === 'min' || value === 'max' || value === 'count'
);

const isDisplayFormat = (value: unknown): value is DisplayFormat => (
  value === 'number' || value === 'currency' || value === 'percent'
);

const isThresholdType = (value: unknown): value is ThresholdType => (
  value === 'none' || value === 'minimum' || value === 'maximum'
);

const isKpiStatus = (value: unknown): value is KpiStatus => (
  value === 'healthy' || value === 'breach' || value === 'unavailable'
);

const normalizeEvaluation = (value: unknown): KpiEvaluation | null => {
  if (!isRecord(value) || !isKpiStatus(value.status)) return null;
  const id = textValue(value.id);
  const evaluatedAt = textValue(value.evaluatedAt);
  if (!id || !evaluatedAt) return null;
  return {
    id,
    value: finiteNumber(value.value),
    status: value.status,
    rowCount: nonNegativeInteger(value.rowCount),
    message: textValue(value.message),
    evaluatedAt,
  };
};

const normalizeKpi = (value: unknown): KpiDefinition | null => {
  if (!isRecord(value)) return null;
  if (!isAggregation(value.aggregation) || !isDisplayFormat(value.displayFormat) || !isThresholdType(value.thresholdType)) {
    return null;
  }
  const id = textValue(value.id);
  const name = textValue(value.name);
  const columnName = textValue(value.columnName);
  if (!id || !name || !columnName) return null;
  return {
    id,
    name,
    description: textValue(value.description),
    columnName,
    aggregation: value.aggregation,
    displayFormat: value.displayFormat,
    thresholdType: value.thresholdType,
    thresholdValue: finiteNumber(value.thresholdValue),
    enabled: value.enabled !== false,
    latest: normalizeEvaluation(value.latest),
    createdAt: textValue(value.createdAt),
    updatedAt: textValue(value.updatedAt),
  };
};

const normalizeColumnsResponse = (value: unknown): ColumnsResponse => {
  if (!isRecord(value)) throw new Error('Kolon servisi geçersiz bir yanıt döndürdü.');
  const allColumns = Array.isArray(value.allColumns)
    ? value.allColumns.map(textValue).filter(Boolean)
    : [];
  const numericColumns = Array.isArray(value.numericColumns)
    ? value.numericColumns.flatMap((column): NumericColumn[] => {
      if (!isRecord(column)) return [];
      const name = textValue(column.name);
      return name ? [{ name, nonEmptyCount: nonNegativeInteger(column.nonEmptyCount) }] : [];
    })
    : [];
  let dataset: DatasetSummary | null = null;
  if (isRecord(value.dataset)) {
    const filename = textValue(value.dataset.filename);
    if (filename) dataset = { filename, rowCount: nonNegativeInteger(value.dataset.rowCount) };
  }
  return { dataset, allColumns, numericColumns };
};

const normalizeKpisResponse = (value: unknown): KpiDefinition[] => {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('KPI servisi geçersiz bir yanıt döndürdü.');
  }
  return value.items.map(normalizeKpi).filter((item): item is KpiDefinition => item !== null);
};

const normalizeHistoryResponse = (value: unknown): KpiEvaluation[] => {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error('KPI geçmişi geçersiz bir yanıt döndürdü.');
  }
  return value.items.map(normalizeEvaluation).filter((item): item is KpiEvaluation => item !== null).slice(0, 10);
};

const apiErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload: unknown = await response.json();
    if (!isRecord(payload)) return fallback;
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
    if (isRecord(payload.error)) {
      const message = textValue(payload.error.message);
      if (message) return message;
    }
    return textValue(payload.message) || fallback;
  } catch {
    return fallback;
  }
};

const requestHeaders = (json = false): Headers => {
  const headers = new Headers(authHeaders());
  if (json) {
    const contentHeaders = new Headers(jsonHeaders());
    contentHeaders.forEach((value, key) => headers.set(key, value));
  }
  return headers;
};

const formatDateTime = (value?: string): string => {
  if (!value) return 'Henüz değerlendirilmedi';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Tarih bilinmiyor';
  return date.toLocaleString('tr-TR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const formatValue = (value: number | null, format: DisplayFormat): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  if (format === 'currency') {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: 'TRY',
      maximumFractionDigits: 2,
    }).format(value);
  }
  const formatted = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(value);
  return format === 'percent' ? `%${formatted}` : formatted;
};

const thresholdText = (kpi: KpiDefinition): string => {
  if (kpi.thresholdType === 'none' || kpi.thresholdValue === null) return 'Uyarı eşiği tanımlı değil';
  const value = formatValue(kpi.thresholdValue, kpi.displayFormat);
  return kpi.thresholdType === 'minimum' ? `Hedef: en az ${value}` : `Sınır: en fazla ${value}`;
};

const statusIcon = (status: KpiStatus | null) => {
  if (status === 'healthy') return <CheckCircle2 className="h-4 w-4" aria-hidden="true" />;
  if (status === 'breach') return <AlertTriangle className="h-4 w-4" aria-hidden="true" />;
  if (status === 'unavailable') return <AlertCircle className="h-4 w-4" aria-hidden="true" />;
  return <Clock3 className="h-4 w-4" aria-hidden="true" />;
};

export default function DecisionCenter({ user }: DecisionCenterProps) {
  const [columns, setColumns] = useState<ColumnsResponse | null>(null);
  const [kpis, setKpis] = useState<KpiDefinition[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<KpiFormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [evaluatingKey, setEvaluatingKey] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<KpiEvaluation[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const mountedRef = useRef(false);
  const actionControllersRef = useRef(new Set<AbortController>());

  const canWrite = user.role === 'admin' || user.role === 'analyst';
  const canEvaluate = canWrite;

  useEffect(() => {
    mountedRef.current = true;
    const controllers = actionControllersRef.current;
    return () => {
      mountedRef.current = false;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
    };
  }, []);

  const newActionController = useCallback(() => {
    const controller = new AbortController();
    actionControllersRef.current.add(controller);
    return controller;
  }, []);

  const releaseActionController = useCallback((controller: AbortController) => {
    actionControllersRef.current.delete(controller);
  }, []);

  const loadDashboard = useCallback(async (signal: AbortSignal, showLoader = true) => {
    if (showLoader && mountedRef.current) setIsLoading(true);
    if (mountedRef.current) setLoadError('');
    try {
      const [columnsResponse, kpisResponse] = await Promise.all([
        fetch(getApiUrl('/api/kpis/columns'), { headers: requestHeaders(), signal }),
        fetch(getApiUrl('/api/kpis'), { headers: requestHeaders(), signal }),
      ]);
      if (!columnsResponse.ok) {
        throw new Error(await apiErrorMessage(columnsResponse, 'KPI kolonları yüklenemedi.'));
      }
      if (!kpisResponse.ok) {
        throw new Error(await apiErrorMessage(kpisResponse, 'KPI tanımları yüklenemedi.'));
      }
      const [columnsPayload, kpisPayload]: [unknown, unknown] = await Promise.all([
        columnsResponse.json(),
        kpisResponse.json(),
      ]);
      const nextColumns = normalizeColumnsResponse(columnsPayload);
      const nextKpis = normalizeKpisResponse(kpisPayload);
      if (!mountedRef.current || signal.aborted) return;
      setColumns(nextColumns);
      setKpis(nextKpis);
      setSelectedHistoryId((current) => (
        current && nextKpis.some((kpi) => kpi.id === current) ? current : null
      ));
    } catch (error) {
      if (signal.aborted || !mountedRef.current) return;
      setLoadError(error instanceof Error ? error.message : 'Karar merkezi yüklenemedi.');
    } finally {
      if (mountedRef.current && !signal.aborted && showLoader) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadDashboard(controller.signal);
    return () => controller.abort();
  }, [loadDashboard]);

  const loadHistory = useCallback(async (kpiId: string, signal: AbortSignal) => {
    if (mountedRef.current) {
      setIsHistoryLoading(true);
      setHistoryError('');
    }
    try {
      const response = await fetch(getApiUrl(`/api/kpis/${encodeURIComponent(kpiId)}/history`), {
        headers: requestHeaders(),
        signal,
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'KPI geçmişi yüklenemedi.'));
      const payload: unknown = await response.json();
      const items = normalizeHistoryResponse(payload);
      if (mountedRef.current && !signal.aborted) setHistoryItems(items);
    } catch (error) {
      if (signal.aborted || !mountedRef.current) return;
      setHistoryItems([]);
      setHistoryError(error instanceof Error ? error.message : 'KPI geçmişi yüklenemedi.');
    } finally {
      if (mountedRef.current && !signal.aborted) setIsHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedHistoryId) {
      setHistoryItems([]);
      setHistoryError('');
      return undefined;
    }
    const controller = new AbortController();
    void loadHistory(selectedHistoryId, controller.signal);
    return () => controller.abort();
  }, [loadHistory, selectedHistoryId]);

  const numericColumnNames = useMemo(
    () => new Set((columns?.numericColumns || []).map((column) => column.name)),
    [columns],
  );

  const latestEvaluationAt = useMemo(() => {
    const values = kpis
      .map((kpi) => kpi.latest?.evaluatedAt)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => Date.parse(right) - Date.parse(left));
    return values[0];
  }, [kpis]);

  const breachCount = useMemo(
    () => kpis.filter((kpi) => kpi.enabled && kpi.latest?.status === 'breach').length,
    [kpis],
  );

  const selectedHistoryKpi = useMemo(
    () => kpis.find((kpi) => kpi.id === selectedHistoryId) || null,
    [kpis, selectedHistoryId],
  );

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setFormErrors({});
    setEditingId(null);
    setIsFormOpen(false);
  };

  const openCreateForm = () => {
    if (!canWrite) return;
    setEditingId(null);
    setForm({ ...EMPTY_FORM, columnName: columns?.numericColumns[0]?.name || '' });
    setFormErrors({});
    setNotice(null);
    setIsFormOpen(true);
  };

  const openEditForm = (kpi: KpiDefinition) => {
    if (!canWrite) return;
    setEditingId(kpi.id);
    setForm({
      name: kpi.name,
      description: kpi.description,
      columnName: kpi.columnName,
      aggregation: kpi.aggregation,
      displayFormat: kpi.displayFormat,
      thresholdType: kpi.thresholdType,
      thresholdValue: kpi.thresholdValue === null ? '' : String(kpi.thresholdValue),
      enabled: kpi.enabled,
    });
    setFormErrors({});
    setNotice(null);
    setIsFormOpen(true);
    window.requestAnimationFrame(() => document.getElementById('kpi-form-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const validateForm = (): FormErrors => {
    const errors: FormErrors = {};
    const name = form.name.trim();
    if (name.length < 2) errors.name = 'KPI adı en az 2 karakter olmalıdır.';
    else if (name.length > 80) errors.name = 'KPI adı en fazla 80 karakter olabilir.';
    if (form.description.trim().length > 240) errors.description = 'Açıklama en fazla 240 karakter olabilir.';
    if (!form.columnName) errors.columnName = 'Hesaplanacak kolonu seçin.';
    else if (!columns?.allColumns.includes(form.columnName)) errors.columnName = 'Seçilen kolon güncel veri kaynağında bulunmuyor.';
    else if (form.aggregation !== 'count' && !numericColumnNames.has(form.columnName)) {
      errors.columnName = 'Bu hesaplama için sayısal bir kolon seçmelisiniz.';
    }
    if (form.thresholdType !== 'none') {
      const threshold = Number(form.thresholdValue);
      if (!form.thresholdValue.trim()) errors.thresholdValue = 'Uyarı için bir eşik değeri girin.';
      else if (!Number.isFinite(threshold)) errors.thresholdValue = 'Eşik değeri geçerli bir sayı olmalıdır.';
      else if (Math.abs(threshold) > 1_000_000_000_000) errors.thresholdValue = 'Eşik değeri desteklenen aralığın dışında.';
    }
    return errors;
  };

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canWrite || isSaving) return;
    const errors = validateForm();
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const controller = newActionController();
    setIsSaving(true);
    setNotice(null);
    const thresholdValue = form.thresholdType === 'none' ? null : Number(form.thresholdValue);
    try {
      const response = await fetch(getApiUrl(editingId ? `/api/kpis/${encodeURIComponent(editingId)}` : '/api/kpis'), {
        method: editingId ? 'PATCH' : 'POST',
        headers: requestHeaders(true),
        signal: controller.signal,
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          columnName: form.columnName,
          aggregation: form.aggregation,
          displayFormat: form.displayFormat,
          thresholdType: form.thresholdType,
          thresholdValue,
          enabled: form.enabled,
        }),
      });
      if (!response.ok) {
        throw new Error(await apiErrorMessage(response, editingId ? 'KPI güncellenemedi.' : 'KPI oluşturulamadı.'));
      }
      if (!mountedRef.current || controller.signal.aborted) return;
      const successText = editingId ? 'KPI tanımı güncellendi.' : 'KPI oluşturuldu ve değerlendirmeye hazır.';
      resetForm();
      setNotice({ type: 'success', text: successText });
      await loadDashboard(controller.signal, false);
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'KPI kaydedilemedi.' });
    } finally {
      releaseActionController(controller);
      if (mountedRef.current) setIsSaving(false);
    }
  };

  const handleEvaluate = async (id?: string) => {
    if (!canEvaluate || evaluatingKey !== null) return;
    const controller = newActionController();
    const key = id || 'all';
    setEvaluatingKey(key);
    setNotice(null);
    try {
      const response = await fetch(getApiUrl('/api/kpis/evaluate'), {
        method: 'POST',
        headers: requestHeaders(true),
        signal: controller.signal,
        body: JSON.stringify(id ? { id } : {}),
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'KPI değerlendirmesi tamamlanamadı.'));
      if (!mountedRef.current || controller.signal.aborted) return;
      setNotice({
        type: 'success',
        text: id ? 'KPI güncel veriyle yeniden değerlendirildi.' : 'Etkin KPI’ların tamamı güncel veriyle değerlendirildi.',
      });
      await loadDashboard(controller.signal, false);
      if (selectedHistoryId) await loadHistory(selectedHistoryId, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'KPI değerlendirmesi tamamlanamadı.' });
    } finally {
      releaseActionController(controller);
      if (mountedRef.current) setEvaluatingKey(null);
    }
  };

  const handleDelete = async (kpi: KpiDefinition) => {
    if (!canWrite || deletingId || !window.confirm(`“${kpi.name}” KPI tanımını ve değerlendirme geçmişini silmek istiyor musunuz?`)) return;
    const controller = newActionController();
    setDeletingId(kpi.id);
    setNotice(null);
    try {
      const response = await fetch(getApiUrl(`/api/kpis/${encodeURIComponent(kpi.id)}`), {
        method: 'DELETE',
        headers: requestHeaders(),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'KPI silinemedi.'));
      if (!mountedRef.current || controller.signal.aborted) return;
      if (selectedHistoryId === kpi.id) setSelectedHistoryId(null);
      if (editingId === kpi.id) resetForm();
      setNotice({ type: 'success', text: `${kpi.name} silindi.` });
      await loadDashboard(controller.signal, false);
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setNotice({ type: 'error', text: error instanceof Error ? error.message : 'KPI silinemedi.' });
    } finally {
      releaseActionController(controller);
      if (mountedRef.current) setDeletingId(null);
    }
  };

  const handleRetry = async () => {
    const controller = newActionController();
    await loadDashboard(controller.signal);
    releaseActionController(controller);
  };

  if (isLoading && !columns) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-8" aria-busy="true" aria-label="Karar merkezi yükleniyor">
        <div className="h-32 animate-pulse rounded-3xl border border-slate-200 bg-white dark:border-white/5 dark:bg-white/5" />
        <div className="grid gap-4 md:grid-cols-3">
          {[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl bg-slate-100 dark:bg-white/5" />)}
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-64 animate-pulse rounded-2xl bg-slate-100 dark:bg-white/5" />)}
        </div>
      </div>
    );
  }

  if (loadError && !columns) {
    return (
      <div className="mx-auto flex min-h-[520px] max-w-7xl items-center justify-center rounded-3xl border border-red-200 bg-red-50/60 p-4 text-center dark:border-red-500/20 dark:bg-red-500/5 md:p-8">
        <div className="max-w-md">
          <AlertCircle className="mx-auto h-10 w-10 text-red-500" aria-hidden="true" />
          <h2 className="mt-4 text-lg font-black text-slate-900 dark:text-white">Karar merkezi açılamadı</h2>
          <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">{loadError}</p>
          <button
            type="button"
            onClick={() => void handleRetry()}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-xs font-bold uppercase tracking-wider text-white dark:bg-[#FFD700] dark:text-black"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Tekrar dene
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 pb-10 md:p-8 md:pb-10">
      <section className="overflow-hidden rounded-3xl border border-slate-200/70 bg-white shadow-sm dark:border-white/5 dark:bg-white/5">
        <div className="relative px-5 py-6 sm:px-7 sm:py-7">
          <div className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-indigo-500/10 blur-3xl dark:bg-[#FFD700]/5" />
          <div className="relative flex flex-col justify-between gap-5 lg:flex-row lg:items-center">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-500/15 dark:bg-[#FFD700] dark:text-black">
                <BellRing className="h-6 w-6" aria-hidden="true" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-black tracking-tight text-slate-950 dark:text-white">KPI ve Uyarı Merkezi</h1>
                  {!canWrite && (
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-white/50">
                      Salt okunur
                    </span>
                  )}
                </div>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-white/55">
                  Kurumunuzun kritik göstergelerini tanımlayın; analize dahil edilen uyumlu veri setlerinin tüm satırları üzerinden ölçün ve hedef dışına çıkan değerleri tek ekranda görün.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canWrite && (
                <button
                  type="button"
                  onClick={openCreateForm}
                  disabled={!columns?.dataset || isSaving}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-700 transition hover:border-indigo-300 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-white/75 dark:hover:border-[#FFD700]/40 dark:hover:text-[#FFD700]"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Yeni KPI
                </button>
              )}
              {canEvaluate && (
                <button
                  type="button"
                  onClick={() => void handleEvaluate()}
                  disabled={evaluatingKey !== null || kpis.every((kpi) => !kpi.enabled)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-xs font-black uppercase tracking-wider text-white shadow-lg shadow-indigo-500/15 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#FFD700] dark:text-black dark:hover:bg-[#ffe033]"
                >
                  {evaluatingKey === 'all' ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Activity className="h-4 w-4" aria-hidden="true" />}
                  {evaluatingKey === 'all' ? 'Değerlendiriliyor' : 'Tümünü değerlendir'}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {notice && (
        <div
          role={notice.type === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={cn(
            'flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm font-medium',
            notice.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300',
          )}
        >
          <span className="flex items-start gap-2">
            {notice.type === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            {notice.text}
          </span>
          <button type="button" onClick={() => setNotice(null)} className="rounded-lg p-1 hover:bg-black/5 dark:hover:bg-white/10" aria-label="Bildirimi kapat">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {loadError && columns && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={() => void handleRetry()} className="shrink-0 font-bold underline underline-offset-2">Yenile</button>
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Veri ve KPI özeti">
        <div className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm dark:border-white/5 dark:bg-white/5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 dark:text-white/35">Birleşik analiz kapsamı</span>
            <Database className="h-4 w-4 text-indigo-500 dark:text-[#FFD700]" aria-hidden="true" />
          </div>
          <p className="mt-3 truncate text-base font-black text-slate-900 dark:text-white" title={columns?.dataset?.filename}>
            {columns?.dataset?.filename || 'Veri bulunamadı'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-white/45">
            {columns?.dataset ? `${columns.dataset.rowCount.toLocaleString('tr-TR')} satır · analize dahil tüm uyumlu veri setleri` : 'Önce analize bir veri seti ekleyin'}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm dark:border-white/5 dark:bg-white/5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 dark:text-white/35">Ölçüm alanları</span>
            <BarChart3 className="h-4 w-4 text-sky-500" aria-hidden="true" />
          </div>
          <p className="mt-3 text-2xl font-black text-slate-900 dark:text-white">{(columns?.numericColumns.length || 0).toLocaleString('tr-TR')}</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-white/45">{(columns?.allColumns.length || 0).toLocaleString('tr-TR')} toplam kolondan sayısal olanlar</p>
        </div>
        <div className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm dark:border-white/5 dark:bg-white/5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 dark:text-white/35">Etkin KPI / Uyarı</span>
            <Gauge className="h-4 w-4 text-emerald-500" aria-hidden="true" />
          </div>
          <p className="mt-3 text-2xl font-black text-slate-900 dark:text-white">{kpis.filter((kpi) => kpi.enabled).length} / {kpis.length}</p>
          <p className={cn('mt-1 text-xs', breachCount > 0 ? 'font-bold text-red-600 dark:text-red-300' : 'text-slate-500 dark:text-white/45')}>
            {breachCount > 0 ? `${breachCount} KPI eşik dışında` : 'Aktif eşik ihlali yok'}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm dark:border-white/5 dark:bg-white/5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400 dark:text-white/35">Son tazelik</span>
            <Clock3 className="h-4 w-4 text-violet-500" aria-hidden="true" />
          </div>
          <p className="mt-3 text-sm font-black text-slate-900 dark:text-white">{formatDateTime(latestEvaluationAt)}</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-white/45">Son başarılı KPI değerlendirmesi</p>
        </div>
      </section>

      {!columns?.dataset && (
        <section className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center dark:border-white/10 dark:bg-white/5">
          <Database className="mx-auto h-11 w-11 text-slate-300 dark:text-white/20" aria-hidden="true" />
          <h2 className="mt-4 text-lg font-black text-slate-900 dark:text-white">KPI hesaplamak için veri gerekiyor</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500 dark:text-white/45">
            Veri Merkezi’nden en az bir CSV, JSON veya REST veri setini analiz kapsamına alın. Sayısal kolonlar bulunduğunda KPI oluşturma alanı açılır.
          </p>
        </section>
      )}

      {isFormOpen && canWrite && columns?.dataset && (
        <section className="rounded-3xl border border-indigo-200/70 bg-indigo-50/30 p-5 shadow-sm dark:border-[#FFD700]/20 dark:bg-[#FFD700]/5 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="kpi-form-heading" className="text-lg font-black text-slate-900 dark:text-white">
                {editingId ? 'KPI tanımını düzenle' : 'Yeni KPI oluştur'}
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-white/50">Hesaplama kuralını ve hangi durumda uyarı üretileceğini tanımlayın.</p>
            </div>
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-200 bg-white p-2 text-slate-500 hover:text-slate-900 dark:border-white/10 dark:bg-white/5 dark:text-white/50 dark:hover:text-white" aria-label="KPI formunu kapat">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <form className="mt-6 space-y-5" onSubmit={(event) => void handleSave(event)} noValidate>
            <div className="grid gap-5 lg:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-700 dark:text-white/70">KPI adı *</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  className={cn(inputClassName, formErrors.name && 'border-red-400 focus:border-red-500 dark:border-red-500/60')}
                  placeholder="Örn. Aylık satış hedefi"
                  maxLength={80}
                  aria-invalid={Boolean(formErrors.name)}
                  aria-describedby={formErrors.name ? 'kpi-name-error' : undefined}
                />
                {formErrors.name && <span id="kpi-name-error" className="mt-1.5 block text-xs font-medium text-red-600 dark:text-red-300">{formErrors.name}</span>}
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-700 dark:text-white/70">Açıklama</span>
                <input
                  value={form.description}
                  onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                  className={cn(inputClassName, formErrors.description && 'border-red-400 focus:border-red-500 dark:border-red-500/60')}
                  placeholder="Bu gösterge neden izleniyor?"
                  maxLength={240}
                  aria-invalid={Boolean(formErrors.description)}
                />
                <span className="mt-1.5 block text-right text-[10px] text-slate-400 dark:text-white/30">{form.description.length}/240</span>
              </label>
            </div>

            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-700 dark:text-white/70">Hesaplama *</span>
                <select
                  value={form.aggregation}
                  onChange={(event) => {
                    const aggregation = event.target.value as Aggregation;
                    setForm((current) => ({
                      ...current,
                      aggregation,
                      columnName: aggregation !== 'count' && current.columnName && !numericColumnNames.has(current.columnName) ? '' : current.columnName,
                    }));
                  }}
                  className={inputClassName}
                >
                  {(Object.entries(AGGREGATION_LABELS) as Array<[Aggregation, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-700 dark:text-white/70">Veri kolonu *</span>
                <select
                  value={form.columnName}
                  onChange={(event) => setForm((current) => ({ ...current, columnName: event.target.value }))}
                  className={cn(inputClassName, formErrors.columnName && 'border-red-400 focus:border-red-500 dark:border-red-500/60')}
                  aria-invalid={Boolean(formErrors.columnName)}
                >
                  <option value="">Kolon seçin</option>
                  {(form.aggregation === 'count' ? columns.allColumns : columns.numericColumns.map((column) => column.name)).map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                {formErrors.columnName && <span className="mt-1.5 block text-xs font-medium text-red-600 dark:text-red-300">{formErrors.columnName}</span>}
                {!formErrors.columnName && form.columnName && (
                  <span className="mt-1.5 block text-[10px] text-slate-400 dark:text-white/30">
                    {form.aggregation === 'count'
                      ? 'Dolu hücreler sayılır'
                      : `${columns.numericColumns.find((column) => column.name === form.columnName)?.nonEmptyCount.toLocaleString('tr-TR') || '0'} sayısal kayıt`}
                  </span>
                )}
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-700 dark:text-white/70">Gösterim biçimi *</span>
                <select
                  value={form.displayFormat}
                  onChange={(event) => setForm((current) => ({ ...current, displayFormat: event.target.value as DisplayFormat }))}
                  className={inputClassName}
                >
                  {(Object.entries(DISPLAY_LABELS) as Array<[DisplayFormat, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-slate-700 dark:text-white/70">Uyarı kuralı *</span>
                <select
                  value={form.thresholdType}
                  onChange={(event) => setForm((current) => ({ ...current, thresholdType: event.target.value as ThresholdType }))}
                  className={inputClassName}
                >
                  {(Object.entries(THRESHOLD_LABELS) as Array<[ThresholdType, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>

            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex flex-1 flex-col gap-4 sm:flex-row sm:items-end">
                {form.thresholdType !== 'none' && (
                  <label className="block w-full sm:max-w-xs">
                    <span className="mb-2 block text-xs font-bold text-slate-700 dark:text-white/70">Eşik değeri *</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      step="any"
                      value={form.thresholdValue}
                      onChange={(event) => setForm((current) => ({ ...current, thresholdValue: event.target.value }))}
                      className={cn(inputClassName, formErrors.thresholdValue && 'border-red-400 focus:border-red-500 dark:border-red-500/60')}
                      placeholder="Örn. 100000"
                      aria-invalid={Boolean(formErrors.thresholdValue)}
                    />
                    {formErrors.thresholdValue && <span className="mt-1.5 block text-xs font-medium text-red-600 dark:text-red-300">{formErrors.thresholdValue}</span>}
                  </label>
                )}
                <label className="inline-flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 dark:border-white/10 dark:bg-black/20 dark:text-white/70">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:accent-[#FFD700]"
                  />
                  KPI etkin
                </label>
              </div>
              <div className="flex gap-2 sm:justify-end">
                <button type="button" onClick={resetForm} className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-600 sm:flex-none dark:border-white/10 dark:bg-white/5 dark:text-white/60">Vazgeç</button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-xs font-black uppercase tracking-wider text-white disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none dark:bg-[#FFD700] dark:text-black"
                >
                  {isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
                  {isSaving ? 'Kaydediliyor' : editingId ? 'Değişiklikleri kaydet' : 'KPI oluştur'}
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      {columns?.dataset && kpis.length === 0 && !isFormOpen && (
        <section className="rounded-3xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center dark:border-white/10 dark:bg-white/5">
          <Gauge className="mx-auto h-11 w-11 text-slate-300 dark:text-white/20" aria-hidden="true" />
          <h2 className="mt-4 text-lg font-black text-slate-900 dark:text-white">Henüz izlenen bir KPI yok</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500 dark:text-white/45">
            {canWrite ? 'İş hedefinizi temsil eden bir sayısal kolonu seçin ve normal kabul edilen sınırı tanımlayın.' : 'Admin veya analist rolündeki bir ekip üyesi KPI oluşturduğunda sonuçlar burada görünecek.'}
          </p>
          {canWrite && (
            <button type="button" onClick={openCreateForm} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-xs font-black uppercase tracking-wider text-white dark:bg-[#FFD700] dark:text-black">
              <Plus className="h-4 w-4" aria-hidden="true" /> İlk KPI’yı oluştur
            </button>
          )}
        </section>
      )}

      {kpis.length > 0 && (
        <section aria-labelledby="kpi-list-heading">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="kpi-list-heading" className="text-lg font-black text-slate-900 dark:text-white">İzlenen göstergeler</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-white/40">Kartlar en son kaydedilmiş değerlendirmeyi gösterir.</p>
            </div>
            <span className="text-xs font-bold text-slate-400 dark:text-white/35">{kpis.length} KPI</span>
          </div>
          <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
            {kpis.map((kpi) => {
              const status = kpi.latest?.status || null;
              const statusContent = status ? STATUS_CONTENT[status] : null;
              const isEvaluating = evaluatingKey === kpi.id;
              return (
                <article
                  key={kpi.id}
                  className={cn(
                    'flex min-h-[270px] flex-col rounded-2xl border bg-white p-5 shadow-sm transition dark:bg-white/5',
                    statusContent?.card || 'border-slate-200/70 dark:border-white/5',
                    !kpi.enabled && 'opacity-65',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-base font-black text-slate-900 dark:text-white" title={kpi.name}>{kpi.name}</h3>
                        {!kpi.enabled && <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:border-white/10 dark:text-white/35">Pasif</span>}
                      </div>
                      <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-xs leading-5 text-slate-500 dark:text-white/45">{kpi.description || `${kpi.columnName} kolonu için ${AGGREGATION_LABELS[kpi.aggregation].toLocaleLowerCase('tr-TR')} hesaplanır.`}</p>
                    </div>
                    {statusContent ? (
                      <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider', statusContent.badge)}>
                        {statusIcon(status)} {statusContent.label}
                      </span>
                    ) : (
                      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-white/45">
                        {statusIcon(null)} Bekliyor
                      </span>
                    )}
                  </div>

                  <div className="mt-5 flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-white/30">Güncel değer</p>
                      <p className={cn('mt-1 truncate text-3xl font-black tracking-tight', status === 'breach' ? 'text-red-600 dark:text-red-300' : 'text-slate-950 dark:text-white')} title={formatValue(kpi.latest?.value ?? null, kpi.displayFormat)}>
                        {formatValue(kpi.latest?.value ?? null, kpi.displayFormat)}
                      </p>
                    </div>
                    <div className="text-right text-[10px] leading-5 text-slate-400 dark:text-white/35">
                      <p className="font-bold text-slate-600 dark:text-white/55">{AGGREGATION_LABELS[kpi.aggregation]}</p>
                      <p>{kpi.columnName}</p>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-3 dark:border-white/5 dark:bg-black/20">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-bold text-slate-700 dark:text-white/65">{thresholdText(kpi)}</span>
                      <span className="text-slate-400 dark:text-white/35">{kpi.latest ? `${kpi.latest.rowCount.toLocaleString('tr-TR')} satır` : 'Ölçüm yok'}</span>
                    </div>
                    <p className={cn('mt-1.5 text-[11px] leading-5', status === 'breach' ? 'font-semibold text-red-600 dark:text-red-300' : 'text-slate-500 dark:text-white/40')}>
                      {kpi.latest?.message || 'Bu KPI henüz değerlendirilmedi.'}
                    </p>
                  </div>

                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4 dark:border-white/5">
                    <span className="text-[10px] text-slate-400 dark:text-white/30">{formatDateTime(kpi.latest?.evaluatedAt)}</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setSelectedHistoryId((current) => current === kpi.id ? null : kpi.id)}
                        className={cn('rounded-lg p-2 transition', selectedHistoryId === kpi.id ? 'bg-indigo-50 text-indigo-700 dark:bg-[#FFD700]/10 dark:text-[#FFD700]' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-white')}
                        aria-label={`${kpi.name} geçmişini ${selectedHistoryId === kpi.id ? 'kapat' : 'göster'}`}
                        aria-expanded={selectedHistoryId === kpi.id}
                      >
                        <History className="h-4 w-4" aria-hidden="true" />
                      </button>
                      {canEvaluate && (
                        <button
                          type="button"
                          onClick={() => void handleEvaluate(kpi.id)}
                          disabled={!kpi.enabled || evaluatingKey !== null}
                          className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/10 dark:hover:text-[#FFD700]"
                          aria-label={`${kpi.name} KPI değerini güncelle`}
                        >
                          {isEvaluating ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                        </button>
                      )}
                      {canWrite && (
                        <button type="button" onClick={() => openEditForm(kpi)} className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-white/10 dark:hover:text-white" aria-label={`${kpi.name} KPI tanımını düzenle`}>
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                      {canWrite && (
                        <button
                          type="button"
                          onClick={() => void handleDelete(kpi)}
                          disabled={deletingId !== null}
                          className="rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-500/10 dark:hover:text-red-300"
                          aria-label={`${kpi.name} KPI tanımını sil`}
                        >
                          {deletingId === kpi.id ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {selectedHistoryKpi && (
        <section className="rounded-3xl border border-slate-200/70 bg-white p-5 shadow-sm dark:border-white/5 dark:bg-white/5 sm:p-7" aria-labelledby="history-heading">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-indigo-600 dark:text-[#FFD700]">
                <History className="h-4 w-4" aria-hidden="true" />
                <span className="text-[10px] font-bold uppercase tracking-[0.16em]">Son 10 ölçüm</span>
              </div>
              <h2 id="history-heading" className="mt-2 text-lg font-black text-slate-900 dark:text-white">{selectedHistoryKpi.name} geçmişi</h2>
              <p className="mt-1 text-xs text-slate-500 dark:text-white/40">Her kayıt, o anda analize dahil edilen uyumlu veri setlerinin tüm satırları üzerinden hesaplanmıştır.</p>
            </div>
            <button type="button" onClick={() => setSelectedHistoryId(null)} className="rounded-xl border border-slate-200 p-2 text-slate-400 hover:text-slate-800 dark:border-white/10 dark:hover:text-white" aria-label="KPI geçmişini kapat">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {isHistoryLoading ? (
            <div className="flex min-h-32 items-center justify-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-400" role="status">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Geçmiş yükleniyor
            </div>
          ) : historyError ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300" role="alert">{historyError}</div>
          ) : historyItems.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-white/10 dark:text-white/40">Bu KPI için henüz değerlendirme geçmişi yok.</div>
          ) : (
            <ol className="mt-5 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/70 dark:divide-white/5 dark:border-white/10" aria-label={`${selectedHistoryKpi.name} değerlendirme geçmişi`}>
              {historyItems.map((item, index) => {
                const content = STATUS_CONTENT[item.status];
                return (
                  <li key={item.id} className="grid gap-3 px-4 py-3.5 sm:grid-cols-[2rem_1fr_auto_auto] sm:items-center">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-[10px] font-black text-slate-500 dark:bg-white/5 dark:text-white/40" aria-hidden="true">{index + 1}</span>
                    <div>
                      <p className="text-sm font-black text-slate-900 dark:text-white">{formatValue(item.value, selectedHistoryKpi.displayFormat)}</p>
                      <p className="mt-0.5 text-[10px] text-slate-400 dark:text-white/35">{item.message || `${item.rowCount.toLocaleString('tr-TR')} satır değerlendirildi`}</p>
                    </div>
                    <span className={cn('inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider', content.badge)}>
                      {statusIcon(item.status)} {content.label}
                    </span>
                    <time dateTime={item.evaluatedAt} className="text-xs text-slate-400 dark:text-white/35">{formatDateTime(item.evaluatedAt)}</time>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}

      {!canWrite && (
        <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-white/45">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500 dark:text-[#FFD700]" aria-hidden="true" />
          Viewer rolü KPI sonuçlarını ve geçmişini salt okunur olarak inceleyebilir. KPI oluşturma, değiştirme, silme ve yeniden değerlendirme işlemleri admin veya analist yetkisi gerektirir.
        </div>
      )}
    </div>
  );
}
