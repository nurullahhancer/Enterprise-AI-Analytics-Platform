import React, { useEffect, useState, useCallback } from 'react';
import { 
  Area, AreaChart, Bar, BarChart, CartesianGrid, 
  ResponsiveContainer, Tooltip, XAxis, YAxis, LineChart, Line 
} from 'recharts';
import { 
  Activity, AlertTriangle, BarChart3, Brain, Download, 
  Lightbulb, LineChart as LineIcon, PieChart,
  Sparkles, Table2, TrendingUp, HelpCircle 
} from 'lucide-react';
import { authHeaders, getApiUrl } from '../lib/api';
import { downloadReport } from '../lib/reports';
import { cn } from '../lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

type WidgetType = 'kpi' | 'trend' | 'forecast' | 'anomaly' | 'segment' | 'topN' | 'profile';

interface DashboardWidget {
  id: string; 
  type: WidgetType; 
  title: string;
  score: number; 
  confidence?: number; 
  data: any;
}

interface DynamicDashboardResponse {
  datasetId?: number;
  datasetFilename?: string;
  emptyState: string | null;
  profile: {
    rowCount: number; 
    columnCount: number; 
    datasetType: string;
    columns: Array<{ name: string; type: string; nullRate: number; uniqueCount: number; mean: number | null }>;
  } | null;
  widgets: DashboardWidget[];
}

interface AutoInsightResponse {
  generatedAt: string; 
  datasetType: string | null; 
  rowCount: number;
  summary: string;
  items: Array<{ title: string; description: string; severity: 'info' | 'success' | 'warning'; score: number }>;
}

interface MlForecast {
  filename: string;
  model: string;
  targetColumn: string | null;
  rowCount: number;
  featureCount: number;
  trainRows: number;
  testRows: number;
  accuracy: number;
  series: Array<{ row: string; actual: number | null; predicted: number }>;
  forecast: Array<{ row: string; predicted: number }>;
  anomalies: Array<{ name: string; value: number }>;
}

const emptyForecast: MlForecast = {
  filename: 'Veri seti yok',
  model: 'Model beklemede',
  targetColumn: null,
  rowCount: 0,
  featureCount: 0,
  trainRows: 0,
  testRows: 0,
  accuracy: 0,
  series: [],
  forecast: [],
  anomalies: []
};

const emptyDashboard: DynamicDashboardResponse = {
  emptyState: 'Veri arttıkça burada içgörüler görünecek. Başlamak için veri setlerinizi yükleyin.',
  profile: null, 
  widgets: []
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const formatMoney = (v: number) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 }).format(v);

const formatValue = (v: number, fmt?: string) =>
  fmt === 'currency' ? formatMoney(v) : fmt === 'percent' ? `${v.toFixed(1)}%` : new Intl.NumberFormat('tr-TR').format(v);

const confidenceLabel = (v?: number) => `${Math.round((v ?? 0) * 100)}% heuristik uyum`;

// ─── Widget Components ────────────────────────────────────────────────────────

function WidgetShell({ widget, children, isDark }: { widget: DashboardWidget; children: React.ReactNode; isDark: boolean }) {
  return (
    <section className="bg-white dark:bg-white/5 border border-slate-200/60 dark:border-white/5 rounded-2xl p-5 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="text-sm md:text-base font-bold text-slate-800 dark:text-[#F0F0F0] truncate uppercase tracking-tight">{widget.title}</h3>
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-white/40 mt-1">ÖNCELİK SKORU: {Math.round(widget.score * 100)}</p>
        </div>
        {widget.confidence !== undefined && (
          <span className="shrink-0 px-2.5 py-1 rounded-full bg-indigo-50 dark:bg-[#FFD700]/10 text-indigo-600 dark:text-[#FFD700] border border-indigo-100 dark:border-[#FFD700]/20 text-[10px] font-bold uppercase tracking-wider">
            {confidenceLabel(widget.confidence)}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function KpiWidget({ widget, isDark }: { widget: DashboardWidget; isDark: boolean }) {
  return (
    <WidgetShell widget={widget} isDark={isDark}>
      <div className="flex items-center justify-between gap-4 py-2">
        <div>
          <p className="text-3xl font-black tracking-tight text-indigo-600 dark:text-[#FFD700]">
            {formatValue(Number(widget.data.value ?? 0), widget.data.format)}
          </p>
          <p className="text-xs font-medium text-slate-500 dark:text-white/45 mt-2 uppercase tracking-wide">{widget.data.helper}</p>
        </div>
        <div className="w-12 h-12 rounded-xl bg-indigo-50 dark:bg-white/5 border border-indigo-100 dark:border-white/10 flex items-center justify-center">
          <Activity className="w-5 h-5 text-indigo-600 dark:text-[#FFD700]" />
        </div>
      </div>
    </WidgetShell>
  );
}

function TrendWidget({ widget, isDark }: { widget: DashboardWidget; isDark: boolean }) {
  const data = Array.isArray(widget.data) && widget.data.length > 0 ? widget.data : [{ name: 'Veri yok', ciro: 0 }];
  const accentColor = isDark ? "#FFD700" : "#4F46E5";
  const gridColor = isDark ? "#222" : "#E2E8F0";
  const tooltipStyle = isDark 
    ? { backgroundColor: '#111', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: '12px' }
    : { backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', color: '#000', fontSize: '12px' };

  return (
    <WidgetShell widget={widget} isDark={isDark}>
      <div className="h-[260px] md:h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
            <defs>
              <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={accentColor} stopOpacity={0.3} />
                <stop offset="95%" stopColor={accentColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
            <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: isDark ? '#888' : '#64748B', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: isDark ? '#888' : '#64748B', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Area type="monotone" dataKey="ciro" stroke={accentColor} strokeWidth={3} fill="url(#trendGrad)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </WidgetShell>
  );
}

function ForecastWidget({ widget, isDark }: { widget: DashboardWidget; isDark: boolean }) {
  const points = widget.data.data ?? [];
  return (
    <WidgetShell widget={widget} isDark={isDark}>
      <div className="flex flex-col gap-1 mb-4 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-white/60">
        <div className="flex items-center gap-3">
          <Brain className="w-4 h-4 text-indigo-600 dark:text-[#FFD700]" />
          <span>{widget.data.targetColumn || 'Hedef kolon yok'}</span>
        </div>
        <div className="pl-7">{widget.data.model} | RMSE {Number(widget.data.metrics?.rmse ?? 0)}</div>
      </div>
      {widget.data.debug?.rmseIsSuspicious && (
        <div className="mb-4 rounded-xl border border-pink-500/20 bg-pink-500/10 px-3 py-2 text-xs font-bold text-pink-200">
          RMSE 0 göründüğü için güven skoru düşürüldü.
        </div>
      )}
      {points.length === 0 && (
        <div className="mb-4 rounded-xl border border-slate-100 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-xs font-bold text-slate-500 dark:text-white/70">
          Tahmin üretmek için en az 3 sayısal hedef değeri gerekiyor.
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {points.map((p: any) => (
          <div key={p.row} className="rounded-xl bg-slate-50 dark:bg-black/30 border border-slate-200/50 dark:border-white/5 p-3">
            <p className="text-[10px] font-mono uppercase text-slate-400 dark:text-white/40">{p.row}</p>
            <p className="text-lg font-black text-indigo-600 dark:text-[#FFD700] mt-1">{formatMoney(Number(p.predicted ?? 0))}</p>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}

function AnomalyWidget({ widget, isDark }: { widget: DashboardWidget; isDark: boolean }) {
  const anomalies = widget.data.data ?? [];
  return (
    <WidgetShell widget={widget} isDark={isDark}>
      <div className="flex items-center gap-3 text-pink-500 mb-4">
        <AlertTriangle className="w-5 h-5" />
        <p className="text-sm font-bold">{anomalies.length} aykırı değer bulundu.</p>
      </div>
      <div className="space-y-2">
        {anomalies.slice(0, 4).map((item: any) => (
          <div key={item.label} className="flex items-center justify-between gap-3 text-sm rounded-xl bg-pink-500/5 dark:bg-pink-500/10 border border-pink-500/20 px-3 py-2 text-slate-800 dark:text-[#F0F0F0]">
            <span className="truncate">{item.label}</span>
            <strong className="text-pink-600 dark:text-pink-400">{formatMoney(Number(item.value ?? 0))}</strong>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}

function SegmentWidget({ widget, isDark }: { widget: DashboardWidget; isDark: boolean }) {
  const data = widget.data.data ?? [];
  const gridColor = isDark ? "#222" : "#E2E8F0";
  const barColor = isDark ? "#22d3ee" : "#06b6d4";
  const tooltipStyle = isDark 
    ? { backgroundColor: '#111', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: '12px' }
    : { backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', color: '#000', fontSize: '12px' };

  return (
    <WidgetShell widget={widget} isDark={isDark}>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={gridColor} />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: isDark ? '#888' : '#64748B', fontSize: 10 }} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: isDark ? '#888' : '#64748B', fontSize: 10 }} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="averageValue" fill={barColor} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </WidgetShell>
  );
}

function TopNWidget({ widget, isDark }: { widget: DashboardWidget; isDark: boolean }) {
  const rows = Array.isArray(widget.data) ? widget.data : [];
  return (
    <WidgetShell widget={widget} isDark={isDark}>
      <div className="space-y-2">
        {rows.map((r: any, i: number) => (
          <div key={`${r.name}-${i}`} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 dark:bg-black/25 border border-slate-200/50 dark:border-white/5 px-3 py-2 text-sm text-slate-800 dark:text-white">
            <span className="truncate">{i + 1}. {r.name}</span>
            <strong className="text-indigo-600 dark:text-[#FFD700]">{formatMoney(Number(r.ciro ?? 0))}</strong>
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}

function ProfileWidget({ widget, isDark }: { widget: DashboardWidget; isDark: boolean }) {
  const profile = widget.data;
  const columns = Array.isArray(profile.columns) ? profile.columns : [];
  const numericColumns = columns.filter((c: any) => c.type === 'numeric' || c.type === 'currency').length;
  const dateColumns = columns.filter((c: any) => c.type === 'datetime').length;
  const missingColumns = columns.filter((c: any) => Number(c.nullRate ?? 0) >= 20);
  const qualityScore = columns.length === 0 ? 0 : Math.round(columns.reduce((s: number, c: any) => s + (100 - Number(c.nullRate ?? 0)), 0) / columns.length);
  
  const typeLabels: Record<string, string> = { 
    time_series: 'Zaman Serisi', 
    crm: 'Müşteri İlişkileri (CRM)', 
    transactional: 'İşlem Verisi', 
    financial: 'Finansal Veri', 
    categorical: 'Kategorik Veri' 
  };
  const colLabels: Record<string, string> = { numeric: 'Sayı', currency: 'Para', datetime: 'Tarih', categorical: 'Metin' };
  
  return (
    <WidgetShell widget={widget} isDark={isDark}>
      <div className="rounded-2xl bg-slate-50 dark:bg-black/25 border border-slate-200/50 dark:border-white/5 p-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-[#FFD700]/15 border border-indigo-100 dark:border-[#FFD700]/20 text-indigo-600 dark:text-[#FFD700] flex items-center justify-center shrink-0">
            <Table2 className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800 dark:text-white">{typeLabels[profile.datasetType] || 'Genel Veri Seti'}</p>
            <p className="text-xs text-slate-500 dark:text-white/60 mt-1">
              {missingColumns.length > 0 ? `${missingColumns.length} kolonda eksik veri var.` : 'Tüm kolonlar analiz edilebilir düzeyde.'}
            </p>
          </div>
        </div>
      </div>
      
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          ['Toplam Kayıt', profile.rowCount, ''], 
          ['Kolon Sayısı', profile.columnCount, ''], 
          ['Sayısal Kolon', numericColumns, 'text-emerald-500'], 
          ['Doluluk Oranı', `${qualityScore}%`, qualityScore >= 80 ? 'text-emerald-500' : 'text-indigo-600 dark:text-[#FFD700]']
        ].map(([label, val, cls]) => (
          <div key={label as string} className="rounded-xl bg-slate-50 dark:bg-black/25 border border-slate-200/50 dark:border-white/5 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/40">{label as string}</p>
            <p className={cn('text-xl font-black text-slate-800 dark:text-white', cls as string)}>{val as any}</p>
          </div>
        ))}
      </div>
      
      {dateColumns > 0 && (
        <div className="mb-4 rounded-xl bg-emerald-500/5 dark:bg-emerald-500/10 border border-emerald-500/20 px-3 py-2.5 text-xs text-emerald-600 dark:text-emerald-300 flex items-center gap-2">
          <Activity className="w-4 h-4 shrink-0" />
          Tarih alanı bulundu; trend tahmini için uygun.
        </div>
      )}
      {missingColumns.length > 0 && (
        <div className="mb-4 rounded-xl bg-amber-500/5 dark:bg-[#FFD700]/10 border border-amber-500/20 dark:border-[#FFD700]/20 px-3 py-2.5 text-xs text-amber-600 dark:text-[#FFD700] flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          Eksik veri içeren alanlar: {missingColumns.slice(0, 2).map((c: any) => c.name).join(', ')}
        </div>
      )}
      <div className="space-y-2">
        {columns.slice(0, 6).map((c: any) => (
          <div key={c.name} className="rounded-xl bg-slate-50 dark:bg-black/20 border border-slate-200/30 dark:border-transparent px-3 py-2">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="truncate font-bold text-slate-800 dark:text-white">{c.name}</span>
              <span className="text-indigo-600 dark:text-[#FFD700] font-bold uppercase text-[10px] tracking-wider">
                {colLabels[c.type] || 'Alan'}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-slate-400 dark:text-white/40 font-medium">
              <span>{c.uniqueCount} farklı değer</span>
              <span>{Number(c.nullRate ?? 0) > 0 ? `%${c.nullRate} eksik veri` : 'Eksik veri yok'}</span>
            </div>
            {(c.type === 'numeric' || c.type === 'currency') && c.mean !== null && (
              <p className="mt-1 text-[10px] text-emerald-600 dark:text-emerald-300/80">Ortalama: {formatValue(Number(c.mean))}</p>
            )}
          </div>
        ))}
      </div>
    </WidgetShell>
  );
}

function renderWidget(widget: DashboardWidget, isDark: boolean) {
  if (widget.type === 'kpi') return <KpiWidget widget={widget} isDark={isDark} />;
  if (widget.type === 'trend') return <TrendWidget widget={widget} isDark={isDark} />;
  if (widget.type === 'forecast') return <ForecastWidget widget={widget} isDark={isDark} />;
  if (widget.type === 'anomaly') return <AnomalyWidget widget={widget} isDark={isDark} />;
  if (widget.type === 'segment') return <SegmentWidget widget={widget} isDark={isDark} />;
  if (widget.type === 'topN') return <TopNWidget widget={widget} isDark={isDark} />;
  return <ProfileWidget widget={widget} isDark={isDark} />;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const [dashboard, setDashboard] = useState<DynamicDashboardResponse>(emptyDashboard);
  const [isDashboardLoading, setIsDashboardLoading] = useState(false);
  const [reportStatus, setReportStatus] = useState('');
  const [autoInsights, setAutoInsights] = useState<AutoInsightResponse | null>(null);
  const [isInsightLoading, setIsInsightLoading] = useState(false);
  const [expandedInsights, setExpandedInsights] = useState<Record<string, boolean>>({});
  
  // Tab control inside Dashboard
  const [subTab, setSubTab] = useState<'overview' | 'forecast'>('overview');
  const [forecastData, setForecastData] = useState<MlForecast>(emptyForecast);
  const [forecastStatus, setForecastStatus] = useState('');
  
  // Drag and Drop Layout states
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);

  useEffect(() => {
    if (dashboard.widgets && dashboard.widgets.length > 0) {
      const savedOrder = localStorage.getItem(`reai_widget_order_${dashboard.datasetFilename}`);
      if (savedOrder) {
        try {
          const orderedIds = JSON.parse(savedOrder);
          const ordered = orderedIds.map((id: string) => dashboard.widgets.find(w => w.id === id)).filter(Boolean);
          const remaining = dashboard.widgets.filter(w => !orderedIds.includes(w.id));
          setWidgets([...ordered, ...remaining]);
        } catch (e) {
          setWidgets(dashboard.widgets);
        }
      } else {
        setWidgets(dashboard.widgets);
      }
    } else {
      setWidgets([]);
    }
  }, [dashboard]);

  const handleDragStart = (id: string) => {
    if (!isEditMode) return;
    setDraggedId(id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!isEditMode) return;
    e.preventDefault();
  };

  const handleDrop = (targetId: string) => {
    if (!isEditMode || !draggedId || draggedId === targetId) return;

    const dragIndex = widgets.findIndex(w => w.id === draggedId);
    const targetIndex = widgets.findIndex(w => w.id === targetId);

    const reordered = [...widgets];
    const [draggedItem] = reordered.splice(dragIndex, 1);
    reordered.splice(targetIndex, 0, draggedItem);

    setWidgets(reordered);
    localStorage.setItem(`reai_widget_order_${dashboard.datasetFilename}`, JSON.stringify(reordered.map(w => w.id)));
    setDraggedId(null);
  };

  // Theme check helper
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    setIsDark(document.documentElement.classList.contains('dark'));
    return () => observer.disconnect();
  }, []);

  // Load dashboard from all uploaded files.
  const loadDashboard = useCallback(async () => {
    setIsDashboardLoading(true);
    setAutoInsights(null);
    try {
      const res = await fetch(getApiUrl('/api/dashboard/dynamic'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Dashboard hazırlanamadı.');
      setDashboard(data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsDashboardLoading(false);
    }
  }, []);

  // Load forecast metrics
  const loadForecast = useCallback(async () => {
    try {
      const response = await fetch(getApiUrl('/api/ml/forecast'), { headers: authHeaders() });
      const data = await response.json();
      if (response.ok) {
        setForecastData(data);
        setForecastStatus(`${data.targetColumn || 'seçili alan'} için tahmin modeli hazır.`);
      }
    } catch (error) {
      setForecastStatus('Tahmin modeli yüklenirken bir hata oluştu.');
    }
  }, []);

  useEffect(() => { 
    loadDashboard(); 
    loadForecast();
  }, [loadDashboard, loadForecast]);

  const hasDataset = Boolean(dashboard.profile);

  const loadAutoInsights = async () => {
    if (!hasDataset) { setReportStatus('Otomatik içgörü almak için önce veri yükleyin.'); return; }
    setIsInsightLoading(true);
    try {
      const res = await fetch(getApiUrl('/api/insights/auto'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Otomatik içgörü üretilemedi.');
      setAutoInsights(data);
      setExpandedInsights({});
    } catch (err) {
      setReportStatus(err instanceof Error ? err.message : 'Otomatik içgörü üretilemedi.');
    } finally {
      setIsInsightLoading(false);
    }
  };

  const downloadDashboardReport = async () => {
    if (!hasDataset) { setReportStatus('Rapor indirmek için önce veri yükleyin.'); return; }
    try {
      await downloadReport('dashboard');
      setReportStatus('Rapor indirme işlemi arka planda başlatıldı.');
    } catch {
      setReportStatus('Rapor oluşturulurken bir hata oluştu.');
    }
  };

  const toggleInsightDetail = (title: string) => setExpandedInsights((cur) => ({ ...cur, [title]: !cur[title] }));

  // Combined chart forecast series
  const lineChartData = [
    ...forecastData.series,
    ...forecastData.forecast.map((point) => ({ row: point.row, actual: null, predicted: point.predicted }))
  ];

  return (
    <div className="p-4 md:p-12 flex-1 flex flex-col gap-4 md:gap-8 overflow-y-auto">
      {/* Header */}
      <div className={cn(
        "flex flex-col lg:flex-row lg:justify-between lg:items-end pb-5 gap-4 border-b",
        isDark ? "border-white/5" : "border-slate-200"
      )}>
        <div className="flex items-center gap-4">
          <div className={cn(
            "w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg rotate-[-4deg] shrink-0",
            isDark ? "bg-[#FFD700] shadow-[#FFD700]/10" : "bg-[#4F46E5] shadow-[#4F46E5]/15"
          )}>
            <div className={cn(
              "w-5 h-5 rounded-full shadow-inner",
              isDark ? "bg-black" : "bg-white"
            )} />
          </div>
          <div>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight">
              <span>Re</span><span className={isDark ? "text-[#FFD700]" : "text-[#4F46E5]"}>AI</span> Analiz Paneli
            </h2>
            {dashboard.datasetFilename && (
              <p className="text-xs font-mono text-slate-400 dark:text-white/40 mt-1 truncate max-w-md">
                Birleşik analiz kapsamı: {dashboard.datasetFilename}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Sub-tab selection */}
          <div className={cn(
            "flex items-center p-1 rounded-xl border",
            isDark ? "bg-white/5 border-white/5" : "bg-slate-100 border-slate-200"
          )}>
            <button
              onClick={() => setSubTab('overview')}
              className={cn(
                "px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all",
                subTab === 'overview'
                  ? (isDark ? "bg-white/10 text-white shadow-sm" : "bg-white text-slate-800 shadow-sm")
                  : "text-slate-500 dark:text-white/40 hover:text-slate-800 dark:hover:text-white"
              )}
            >
              Genel Özet
            </button>
            <button
              onClick={() => setSubTab('forecast')}
              className={cn(
                "px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all",
                subTab === 'forecast'
                  ? (isDark ? "bg-white/10 text-white shadow-sm" : "bg-white text-slate-800 shadow-sm")
                  : "text-slate-500 dark:text-white/40 hover:text-slate-800 dark:hover:text-white"
              )}
            >
              Tahmin Modeli (ML)
            </button>
          </div>

          {subTab === 'overview' && hasDataset && (
            <button
              onClick={() => setIsEditMode(!isEditMode)}
              className={cn(
                "px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 active:scale-95 shadow-sm border",
                isEditMode
                  ? "bg-rose-500/10 border-rose-500/20 text-rose-500 hover:bg-rose-500/20"
                  : (isDark
                      ? "border-white/10 hover:bg-white hover:text-black text-white"
                      : "border-slate-300 hover:bg-slate-50 text-slate-700")
              )}
            >
              <TrendingUp className="w-4 h-4 shrink-0" />
              {isEditMode ? 'Düzenlemeyi Bitir' : 'Düzeni Düzenle'}
            </button>
          )}

          <button
            onClick={loadAutoInsights}
            disabled={!hasDataset || isInsightLoading}
            className={cn(
              "px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm border",
              isDark 
                ? "bg-[#FFD700] border-[#FFD700] text-black hover:bg-[#ffe033]" 
                : "bg-[#4F46E5] border-[#4F46E5] text-white hover:bg-[#4338ca]"
            )}
          >
            <Sparkles className="w-4 h-4 shrink-0" />
            {isInsightLoading ? 'Hesaplanıyor' : 'Akıllı İçgörü'}
          </button>

          <button
            onClick={downloadDashboardReport}
            disabled={!hasDataset}
            className={cn(
              "px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed border",
              isDark 
                ? "border-white/20 hover:bg-white hover:text-black text-white" 
                : "border-slate-300 hover:bg-slate-50 text-slate-700"
            )}
          >
            <Download className="w-4 h-4 shrink-0" />
            PDF Raporu
          </button>
        </div>
      </div>

      {/* Status Warning / Info */}
      {reportStatus && (
        <div className={cn(
          "border rounded-2xl px-4 py-3 text-xs font-bold uppercase tracking-wider shadow-sm flex items-center gap-2",
          isDark 
            ? "bg-[#FFD700]/10 border-[#FFD700]/20 text-[#FFD700]" 
            : "bg-indigo-50 border-indigo-100 text-indigo-700"
        )}>
          <AlertTriangle className="w-4 h-4" />
          {reportStatus}
        </div>
      )}

      {/* Loading Skeleton */}
      {isDashboardLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white dark:bg-white/5 border border-slate-100 dark:border-white/5 rounded-2xl p-6 h-56 animate-pulse" />
          ))}
        </div>
      )}

      {/* Auto Insights Drawer/Panel */}
      {!isDashboardLoading && autoInsights && (
        <section className={cn(
          "border rounded-2xl p-6 shadow-sm",
          isDark ? "bg-[#FFD700]/10 border-[#FFD700]/20" : "bg-indigo-50/50 border-indigo-100/50"
        )}>
          <div className="flex items-start gap-4 mb-4">
            <div className={cn(
              "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-sm",
              isDark ? "bg-[#FFD700] text-black" : "bg-[#4F46E5] text-white"
            )}>
              <Lightbulb className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800 dark:text-white uppercase tracking-tight">Akıllı İçgörü Özet Raporu</h3>
              <p className="text-sm text-slate-600 dark:text-white/70 mt-1 leading-relaxed">{autoInsights.summary}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
            {autoInsights.items.map((item) => (
              <div key={item.title} className="rounded-xl bg-white dark:bg-black/25 border border-slate-200/55 dark:border-white/10 px-5 py-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-tight">{item.title}</h4>
                  <span className={cn(
                    "text-[10px] font-black uppercase px-2 py-0.5 rounded",
                    item.severity === 'warning' 
                      ? 'bg-red-50 text-red-500 dark:bg-red-500/10 dark:text-red-400' 
                      : item.severity === 'success' 
                        ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400' 
                        : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400'
                  )}>
                    {Math.round(item.score * 100)} SKOR
                  </span>
                </div>
                {expandedInsights[item.title] && (
                  <div className="mt-3 rounded-lg bg-slate-50 dark:bg-black/25 border border-slate-100 dark:border-white/10 p-3">
                    <p className="text-xs md:text-sm text-slate-600 dark:text-white/70 leading-relaxed">{item.description}</p>
                  </div>
                )}
                <button 
                  onClick={() => toggleInsightDetail(item.title)} 
                  className={cn(
                    "mt-3 px-3 py-1.5 rounded-full border text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 active:scale-95 transition-colors",
                    isDark
                      ? "border-white/10 bg-white/5 text-white/80 hover:bg-white/10"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  )}
                >
                  <ChevronDownIcon className={cn('w-3 h-3 transition-transform', expandedInsights[item.title] && 'rotate-180')} />
                  {expandedInsights[item.title] ? 'Detayları Gizle' : 'Detayları Gör'}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Tab Contents */}
      {!isDashboardLoading && (
        dashboard.widgets.length === 0 ? (
          <div className="min-h-[380px] flex flex-col items-center justify-center text-center border border-dashed border-slate-300 dark:border-white/10 rounded-3xl bg-white dark:bg-white/5 px-6">
            <LineIcon className="w-12 h-12 text-slate-400 dark:text-[#FFD700] mb-4" />
            <h3 className="text-lg font-bold text-slate-800 dark:text-white uppercase tracking-tight">Analiz Edilecek Veri Bekleniyor</h3>
            <p className="text-sm text-slate-500 dark:text-white/50 max-w-md mt-2 leading-relaxed">{dashboard.emptyState}</p>
          </div>
        ) : (
          subTab === 'overview' ? (
            /* OVERVIEW TAB */
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {widgets.map((widget) => (
                <div
                  key={widget.id}
                  draggable={isEditMode}
                  onDragStart={() => handleDragStart(widget.id)}
                  onDragOver={handleDragOver}
                  onDrop={() => handleDrop(widget.id)}
                  className={cn(
                    widget.type === 'trend' || widget.type === 'profile' ? 'xl:col-span-2' : '',
                    isEditMode && "cursor-move border border-dashed border-indigo-500/50 rounded-2xl relative select-none",
                    draggedId === widget.id && "opacity-30"
                  )}
                >
                  {isEditMode && (
                    <div className={cn(
                      "absolute top-3 right-3 rounded-lg px-2 py-1 text-[8px] font-black uppercase tracking-wider z-20 pointer-events-none shadow-sm",
                      isDark ? "bg-[#FFD700] text-black" : "bg-[#4F46E5] text-white"
                    )}>
                      Sürükle
                    </div>
                  )}
                  {renderWidget(widget, isDark)}
                </div>
              ))}
            </div>
          ) : (
            /* ML FORECAST TAB */
            <div className="flex flex-col gap-6">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-5 bg-white dark:bg-white/5 rounded-2xl border border-slate-200/60 dark:border-white/5 shadow-sm">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/40">HEURİSTİK UYUM</p>
                  <p className="text-3xl font-black text-indigo-600 dark:text-[#FFD700] mt-3">{forecastData.accuracy}%</p>
                  <p className="mt-2 text-[10px] text-slate-400 dark:text-white/40 font-mono">Geçmiş eğilime göre</p>
                </div>

                <div className="p-5 bg-white dark:bg-white/5 rounded-2xl border border-slate-200/60 dark:border-white/5 shadow-sm">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/40">GÖZLEMLENEN ALAN</p>
                  <p className="text-3xl font-black text-emerald-600 dark:text-emerald-400 mt-3 truncate">{forecastData.targetColumn || 'Bulunmadı'}</p>
                  <p className="mt-2 text-[10px] text-slate-400 dark:text-white/40 font-mono">Hedef tahmin parametresi</p>
                </div>

                <div className="p-5 bg-white dark:bg-white/5 rounded-2xl border border-slate-200/60 dark:border-white/5 shadow-sm">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/40">EĞİTİM VERİSİ</p>
                  <p className="text-3xl font-black text-pink-600 dark:text-pink-400 mt-3">{forecastData.trainRows} Satır</p>
                  <p className="mt-2 text-[10px] text-slate-400 dark:text-white/40 font-mono">Makine öğrenmesinde işlenen</p>
                </div>

                <div className="p-5 bg-white dark:bg-white/5 rounded-2xl border border-slate-200/60 dark:border-white/5 shadow-sm">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/40">AYKIRI DATA</p>
                  <p className="text-3xl font-black text-cyan-600 dark:text-cyan-400 mt-3">{forecastData.anomalies.length} Adet</p>
                  <p className="mt-2 text-[10px] text-slate-400 dark:text-white/40 font-mono">Z-score ile tespit edilen</p>
                </div>
              </div>

              <div className="bg-white dark:bg-white/5 p-6 md:p-8 rounded-2xl border border-slate-200/60 dark:border-white/5 shadow-sm">
                <h3 className="text-base font-bold text-slate-800 dark:text-white uppercase tracking-tight mb-2">Makine Öğrenmesi Değer ve Tahmin Grafiği</h3>
                <div className="flex items-center gap-4 mb-6 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-white/50">
                  <span className="flex items-center gap-2"><span className="h-0.5 w-5 bg-indigo-600 dark:bg-white" /> Gerçekleşen</span>
                  <span className="flex items-center gap-2"><span className="h-0.5 w-5 border-t-2 border-dashed border-indigo-600 dark:border-[#FFD700]" /> Tahmin</span>
                </div>
                <div className="h-[280px] md:h-[400px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={lineChartData.length > 0 ? lineChartData : [{ row: 'Veri yok', actual: 0, predicted: 0 }]} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? "#222" : "#E2E8F0"} />
                      <XAxis dataKey="row" axisLine={false} tickLine={false} tick={{fill: isDark ? '#888' : '#64748B', fontSize: 10, fontFamily: 'monospace'}} />
                      <YAxis axisLine={false} tickLine={false} tick={{fill: isDark ? '#888' : '#64748B', fontSize: 10, fontFamily: 'monospace'}} />
                      <Tooltip 
                        contentStyle={isDark 
                          ? {backgroundColor: '#111', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: '12px'}
                          : {backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', color: '#000', fontSize: '12px'}
                        } 
                        formatter={(value: any, name: string) => [value, name === 'actual' ? 'Gerçekleşen' : 'Tahmin']}
                      />
                      <Line type="monotone" dataKey="actual" stroke={isDark ? "#fff" : "#4F46E5"} strokeWidth={3} dot={{r: 4, fill: isDark ? '#fff' : '#4F46E5'}} name="Gerçekleşen" />
                      <Line type="monotone" dataKey="predicted" stroke={isDark ? "#FFD700" : "#4F46E5"} strokeWidth={3} strokeDasharray="5 5" dot={{r: 4, fill: isDark ? '#FFD700' : '#4F46E5'}} name="Tahmin" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {forecastData.anomalies.length > 0 && (
                <div className="bg-pink-500/5 dark:bg-pink-500/10 border border-pink-500/20 rounded-2xl p-5 shadow-sm">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-pink-600 dark:text-pink-400 mb-3 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Bulunan Aykırı Veriler
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {forecastData.anomalies.map((item) => (
                      <div key={item.name} className="flex justify-between p-3 rounded-xl bg-white dark:bg-black/20 border border-slate-100 dark:border-white/5 text-sm text-slate-700 dark:text-slate-200">
                        <span>{item.name}</span>
                        <strong className="text-pink-600 dark:text-pink-400">{item.value}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        )
      )}

      {/* Footer Profile Data */}
      {!isDashboardLoading && dashboard.profile && (
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-slate-400 dark:text-white/35 mt-auto">
          <BarChart3 className="w-4 h-4" /><span>{dashboard.profile.datasetType}</span>
          <span className="opacity-20">|</span>
          <PieChart className="w-4 h-4" /><span>{dashboard.profile.columnCount} kolon</span>
          <span className="opacity-20">|</span>
          <Table2 className="w-4 h-4" /><span>{dashboard.profile.rowCount} satır</span>
        </div>
      )}
    </div>
  );
}

// ─── Simple local icons for this view ─────────────────────────────────────────

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  );
}
