import React, { useEffect, useState, useCallback } from 'react';
import { 
  Area, AreaChart, Bar, BarChart, CartesianGrid, 
  ResponsiveContainer, Tooltip, XAxis, YAxis
} from 'recharts';
import { 
  Activity, AlertTriangle, BarChart3, Brain, CalendarDays,
  CheckCircle2, ChevronDown, ChevronUp, Database, Download,
  Hash, KeyRound, Lightbulb, LineChart as LineIcon, PieChart,
  Sparkles, Table2, Tags, TrendingUp, Type as TypeIcon, WalletCards
} from 'lucide-react';
import { authHeaders, getApiUrl } from '../lib/api';
import { downloadReport } from '../lib/reports';
import { cn } from '../lib/utils';
import AnalysisStudio from './AnalysisStudio';

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

interface ProfileColumn {
  name: string;
  type: string;
  nullRate: number;
  uniqueCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  topValues: Array<{ value: string; count: number }>;
}

interface DynamicDashboardResponse {
  datasetId?: number;
  datasetCount?: number;
  datasetFilename?: string;
  emptyState: string | null;
  profile: {
    rowCount: number; 
    columnCount: number; 
    datasetType: string;
    columns: ProfileColumn[];
  } | null;
  widgets: DashboardWidget[];
  template?: { key: string; label: string; reason: string };
  preference?: { order: string[]; hidden: string[]; updatedAt: string | null };
}

interface AutoInsightResponse {
  generatedAt: string; 
  datasetType: string | null; 
  rowCount: number;
  summary: string;
  items: Array<{ title: string; description: string; severity: 'info' | 'success' | 'warning'; score: number }>;
}

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

function WidgetShell({
  widget,
  children,
  isDark,
  description
}: {
  widget: DashboardWidget;
  children: React.ReactNode;
  isDark: boolean;
  description?: string;
}) {
  return (
    <section className="bg-white dark:bg-white/5 border border-slate-200/60 dark:border-white/5 rounded-2xl p-5 shadow-sm min-w-0">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h3 className="text-sm md:text-base font-bold text-slate-800 dark:text-[#F0F0F0] truncate uppercase tracking-tight">{widget.title}</h3>
          {description ? (
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500 dark:text-white/50">{description}</p>
          ) : (
            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-white/40 mt-1">ÖNCELİK SKORU: {Math.round(widget.score * 100)}</p>
          )}
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
  const expectedTotal = points.reduce((sum: number, point: any) => sum + Number(point.predicted ?? 0), 0);
  return (
    <WidgetShell widget={widget} isDark={isDark}>
      <div className="mb-4 flex flex-col gap-1 text-xs font-bold text-slate-500 dark:text-white/60">
        <div className="flex items-center gap-3">
          <Brain className="w-4 h-4 text-indigo-600 dark:text-[#FFD700]" />
          <span>{widget.data.targetColumn || 'Tahmin edilecek bilgi seçilmedi'}</span>
        </div>
        {points.length > 0 && <div className="pl-7 text-sm text-slate-800 dark:text-white">Önümüzdeki {points.length} dönemde yaklaşık {formatMoney(expectedTotal)} bekleniyor.</div>}
      </div>
      {widget.data.debug?.rmseIsSuspicious && (
        <div className="mb-4 rounded-xl border border-pink-500/20 bg-pink-500/10 px-3 py-2 text-xs font-bold text-pink-200">
          Geçmiş kayıtlar çok benzer olduğu için bu tahmini temkinli değerlendirin.
        </div>
      )}
      {points.length === 0 && (
        <div className="mb-4 rounded-xl border border-slate-100 dark:border-white/10 bg-slate-50 dark:bg-white/5 px-3 py-2 text-xs font-bold text-slate-500 dark:text-white/70">
          Tahmin oluşturmak için en az 3 geçmiş sayısal değer gerekiyor.
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
  const columns: ProfileColumn[] = Array.isArray(profile.columns) ? profile.columns : [];
  const [showAllColumns, setShowAllColumns] = useState(false);
  const numericColumns = columns.filter((column) => column.type === 'numeric' || column.type === 'currency');
  const dateColumns = columns.filter((column) => column.type === 'datetime');
  const categoricalColumns = columns.filter((column) => column.type === 'categorical' || column.type === 'text');
  const identifierColumns = columns.filter((column) => column.type === 'id');
  const attentionColumns = columns.filter((column) => Number(column.nullRate ?? 0) >= 10);
  const criticalColumns = columns.filter((column) => Number(column.nullRate ?? 0) >= 50);
  const readyColumns = columns.filter((column) => Number(column.nullRate ?? 0) < 50);
  const qualityScore = columns.length === 0
    ? 0
    : Math.round(columns.reduce((sum, column) => sum + (100 - Number(column.nullRate ?? 0)), 0) / columns.length);
  const visibleColumns = showAllColumns ? columns : columns.slice(0, 6);
  
  const typeLabels: Record<string, string> = { 
    time_series: 'Zaman Serisi', 
    crm: 'Müşteri İlişkileri (CRM)', 
    transactional: 'İşlem Verisi', 
    financial: 'Finansal Veri', 
    categorical: 'Kategorik Veri' 
  };
  const colLabels: Record<string, string> = {
    numeric: 'Ölçüm', currency: 'Para', datetime: 'Tarih', categorical: 'Kategori',
    text: 'Metin', id: 'Kimlik / referans'
  };
  const quality = qualityScore >= 95 && criticalColumns.length === 0
    ? {
        title: 'Veriniz analize hazır',
        description: 'Alanların büyük bölümü dolu ve doğrudan analiz edilebilir.',
        textClass: 'text-emerald-700 dark:text-emerald-300',
        surfaceClass: 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/20 dark:bg-emerald-500/10',
        barClass: 'bg-emerald-500'
      }
    : qualityScore >= 80 && criticalColumns.length === 0
      ? {
          title: 'Veriniz kullanılabilir durumda',
          description: 'Analize başlayabilirsiniz; birkaç alanı kontrol etmek sonucu iyileştirir.',
          textClass: 'text-amber-700 dark:text-[#FFD700]',
          surfaceClass: 'border-amber-200 bg-amber-50 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/10',
          barClass: 'bg-amber-500 dark:bg-[#FFD700]'
        }
      : {
          title: 'Analizden önce kısa bir kontrol önerilir',
          description: 'Eksik alanlar sonuçları etkileyebilir; işaretlenen alanları gözden geçirin.',
          textClass: 'text-rose-700 dark:text-rose-300',
          surfaceClass: 'border-rose-200 bg-rose-50 dark:border-rose-500/20 dark:bg-rose-500/10',
          barClass: 'bg-rose-500'
        };
  const typeIcon = (type: string) => {
    if (type === 'currency') return <WalletCards className="h-4 w-4" />;
    if (type === 'numeric') return <Hash className="h-4 w-4" />;
    if (type === 'datetime') return <CalendarDays className="h-4 w-4" />;
    if (type === 'id') return <KeyRound className="h-4 w-4" />;
    if (type === 'categorical') return <Tags className="h-4 w-4" />;
    return <TypeIcon className="h-4 w-4" />;
  };
  const columnSummary = (column: ProfileColumn): string => {
    if (column.type === 'id') return 'Kayıtları ayırt eder; toplam ve ortalama hesabına katılmaz.';
    if (column.type === 'datetime') return 'Sıralama, dönem karşılaştırması ve trend için kullanılır.';
    if ((column.type === 'numeric' || column.type === 'currency') && column.mean !== null) {
      const format = column.type === 'currency' ? 'currency' : undefined;
      const parts = [`Ortalama ${formatValue(Number(column.mean), format)}`];
      if (column.min !== null) parts.push(`en düşük ${formatValue(Number(column.min), format)}`);
      if (column.max !== null) parts.push(`en yüksek ${formatValue(Number(column.max), format)}`);
      return parts.join(' · ');
    }
    const mostCommon = Array.isArray(column.topValues) ? column.topValues[0] : null;
    return mostCommon ? `En sık görülen: ${mostCommon.value} (${mostCommon.count} kayıt)` : 'Özetlenecek dolu değer bulunamadı.';
  };
  const columnHealth = (column: ProfileColumn) => {
    const nullRate = Number(column.nullRate ?? 0);
    if (nullRate >= 50) return {
      label: 'Eksik yoğun',
      className: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/20 dark:bg-rose-500/10 dark:text-rose-300'
    };
    if (nullRate >= 10) return {
      label: 'Kontrol et',
      className: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/10 dark:text-[#FFD700]'
    };
    return {
      label: 'Hazır',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-300'
    };
  };
  const opportunities = [
    dateColumns.length > 0 && `${dateColumns.length} tarih alanıyla dönem ve trend analizi`,
    numericColumns.length > 0 && `${numericColumns.length} sayısal alanla karşılaştırma ve tahmin`,
    categoricalColumns.length > 0 && `${categoricalColumns.length} grup alanıyla kırılım analizi`
  ].filter((item): item is string => Boolean(item));
  
  return (
    <WidgetShell
      widget={widget}
      isDark={isDark}
      description="Verinizin yapısını, ne kadarının analize hazır olduğunu ve dikkat edilmesi gereken alanları gösterir."
    >
      <div className={cn('mb-4 rounded-2xl border p-4 md:p-5', quality.surfaceClass)}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/70 shadow-sm dark:bg-black/20', quality.textClass)}>
              {qualityScore >= 80 && criticalColumns.length === 0
                ? <CheckCircle2 className="h-6 w-6" />
                : <AlertTriangle className="h-6 w-6" />}
            </div>
            <div className="min-w-0">
              <p className={cn('text-base font-extrabold', quality.textClass)}>{quality.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-white/60">{quality.description}</p>
            </div>
          </div>
          <div className="shrink-0 sm:text-right">
            <div className={cn('text-3xl font-black tracking-tight', quality.textClass)}>%{qualityScore}</div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-white/40">veri doluluğu</div>
          </div>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/70 dark:bg-black/25">
          <div className={cn('h-full rounded-full transition-all duration-500', quality.barClass)} style={{ width: `${qualityScore}%` }} />
        </div>
      </div>
      
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: 'Kayıt', value: new Intl.NumberFormat('tr-TR').format(Number(profile.rowCount ?? 0)), helper: 'incelenen satır', icon: <Database className="h-4 w-4" /> },
          { label: 'Alan', value: profile.columnCount, helper: 'toplam bilgi alanı', icon: <Table2 className="h-4 w-4" /> },
          { label: 'Analize Uygun', value: readyColumns.length, helper: `${columns.length} alanın içinde`, icon: <CheckCircle2 className="h-4 w-4" /> },
          { label: 'Veri Türü', value: typeLabels[profile.datasetType] || 'Genel', helper: 'otomatik tanındı', icon: <BarChart3 className="h-4 w-4" /> }
        ].map((metric) => (
          <div key={metric.label} className="rounded-xl border border-slate-200/60 bg-slate-50 p-3 dark:border-white/5 dark:bg-black/25">
            <div className="flex items-center gap-2 text-indigo-600 dark:text-[#FFD700]">
              {metric.icon}
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/40">{metric.label}</p>
            </div>
            <p className="mt-2 truncate text-xl font-black text-slate-800 dark:text-white" title={String(metric.value)}>{metric.value}</p>
            <p className="mt-0.5 text-[10px] text-slate-400 dark:text-white/35">{metric.helper}</p>
          </div>
        ))}
      </div>
      
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 dark:border-white/10 dark:bg-white/5">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-white">
            <Sparkles className="h-4 w-4 text-indigo-600 dark:text-[#FFD700]" />
            Bu veriyle neler yapılabilir?
          </div>
          <div className="mt-3 space-y-2">
            {opportunities.length > 0 ? opportunities.map((opportunity) => (
              <div key={opportunity} className="flex items-start gap-2 text-xs leading-relaxed text-slate-600 dark:text-white/60">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <span>{opportunity}</span>
              </div>
            )) : (
              <p className="text-xs leading-relaxed text-slate-500 dark:text-white/50">Alan türleri netleştikçe uygun analiz önerileri burada görünür.</p>
            )}
          </div>
        </div>
        <div className="rounded-xl border border-slate-200/60 bg-slate-50 p-4 dark:border-white/10 dark:bg-black/25">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-800 dark:text-white">
            {attentionColumns.length > 0
              ? <AlertTriangle className="h-4 w-4 text-amber-500 dark:text-[#FFD700]" />
              : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
            Dikkat edilmesi gerekenler
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-600 dark:text-white/60">
            {criticalColumns.length > 0
              ? `${criticalColumns.slice(0, 2).map((column) => column.name).join(', ')} alanlarında verinin yarısından fazlası eksik. Analizden önce tamamlayın veya kapsam dışı bırakın.`
              : attentionColumns.length > 0
                ? `${attentionColumns.slice(0, 3).map((column) => column.name).join(', ')} alanlarında eksik değerler var. Analiz yapılabilir, ancak bu alanları kontrol etmek sonucu iyileştirir.`
                : 'Belirgin bir eksik veri sorunu görünmüyor. Doğrudan analize geçebilirsiniz.'}
          </p>
          {identifierColumns.length > 0 && (
            <p className="mt-2 text-[10px] leading-relaxed text-slate-400 dark:text-white/40">
              {identifierColumns.length} kimlik alanı hesaplamalara katılmadan yalnızca kayıtları ayırt etmek için kullanılacak.
            </p>
          )}
        </div>
      </div>

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h4 className="text-sm font-extrabold text-slate-800 dark:text-white">Alanları tanıyın</h4>
          <p className="mt-1 text-xs text-slate-500 dark:text-white/45">Her alanın ne işe yaradığını ve veri durumunu sade biçimde görün.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] font-bold text-slate-500 dark:text-white/45">
          {numericColumns.length > 0 && <span>{numericColumns.length} sayısal</span>}
          {dateColumns.length > 0 && <span>• {dateColumns.length} tarih</span>}
          {categoricalColumns.length > 0 && <span>• {categoricalColumns.length} grup/metin</span>}
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        {visibleColumns.map((column) => {
          const health = columnHealth(column);
          return (
            <div key={column.name} className="rounded-xl border border-slate-200/60 bg-slate-50 p-3.5 dark:border-white/5 dark:bg-black/20">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-indigo-600 shadow-sm dark:bg-white/5 dark:text-[#FFD700]">
                    {typeIcon(column.type)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-slate-800 dark:text-white" title={column.name}>{column.name}</p>
                    <p className="mt-0.5 text-[10px] font-medium text-indigo-600 dark:text-[#FFD700]/80">{colLabels[column.type] || 'Bilgi alanı'}</p>
                  </div>
                </div>
                <span className={cn('shrink-0 rounded-full border px-2 py-1 text-[9px] font-bold', health.className)}>
                  {health.label}
                </span>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-600 dark:text-white/55">{columnSummary(column)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-400 dark:text-white/35">
                <span>{new Intl.NumberFormat('tr-TR').format(column.uniqueCount)} farklı değer</span>
                <span>{Number(column.nullRate ?? 0) > 0 ? `%${column.nullRate} eksik` : 'Eksik değer yok'}</span>
              </div>
            </div>
          );
        })}
      </div>

      {columns.length > 6 && (
        <button
          type="button"
          onClick={() => setShowAllColumns((current) => !current)}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-50 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:bg-white/10"
        >
          {showAllColumns ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {showAllColumns ? 'Alanları daralt' : `Tüm ${columns.length} alanı göster`}
        </button>
      )}
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
  const [dashboardError, setDashboardError] = useState('');
  const [reportStatus, setReportStatus] = useState('');
  const [autoInsights, setAutoInsights] = useState<AutoInsightResponse | null>(null);
  const [isInsightLoading, setIsInsightLoading] = useState(false);
  const [expandedInsights, setExpandedInsights] = useState<Record<string, boolean>>({});
  
  // Tab control inside Dashboard
  const [subTab, setSubTab] = useState<'overview' | 'forecast'>('overview');
  
  // Drag and Drop Layout states
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [isEditMode, setIsEditMode] = useState(false);
  const [hiddenWidgetIds, setHiddenWidgetIds] = useState<string[]>([]);

  useEffect(() => {
    if (dashboard.widgets && dashboard.widgets.length > 0) {
      const serverOrder = dashboard.preference?.order || [];
      const savedOrder = serverOrder.length > 0
        ? JSON.stringify(serverOrder)
        : localStorage.getItem(`reai_widget_order_${dashboard.datasetFilename}`);
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
      setHiddenWidgetIds(dashboard.preference?.hidden || []);
    } else {
      setWidgets([]);
    }
  }, [dashboard]);

  const persistDashboardPreference = useCallback(async (order: string[], hidden: string[]) => {
    try {
      const response = await fetch(getApiUrl('/api/dashboard/preference'), {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ order, hidden })
      });
      if (!response.ok) throw new Error('Dashboard düzeni kaydedilemedi.');
    } catch (error) {
      setReportStatus(error instanceof Error ? error.message : 'Dashboard düzeni kaydedilemedi.');
    }
  }, []);

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
    void persistDashboardPreference(reordered.map((widget) => widget.id), hiddenWidgetIds);
    setDraggedId(null);
  };

  const toggleWidgetVisibility = (widgetId: string) => {
    const hidden = hiddenWidgetIds.includes(widgetId)
      ? hiddenWidgetIds.filter((id) => id !== widgetId)
      : [...hiddenWidgetIds, widgetId];
    setHiddenWidgetIds(hidden);
    void persistDashboardPreference(widgets.map((widget) => widget.id), hidden);
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
    setDashboardError('');
    setAutoInsights(null);
    try {
      const res = await fetch(getApiUrl('/api/dashboard/dynamic'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Dashboard hazırlanamadı.');
      setDashboard(data);
    } catch (err) {
      console.error(err);
      setDashboard(emptyDashboard);
      setDashboardError(err instanceof Error ? err.message : 'Analiz kapsamı hazırlanamadı.');
    } finally {
      setIsDashboardLoading(false);
    }
  }, []);

  useEffect(() => { 
    loadDashboard(); 
  }, [loadDashboard]);

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
                İncelenen veriler: {dashboard.datasetFilename}
              </p>
            )}
            {dashboard.template && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-indigo-700 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/10 dark:text-[#FFD700]">{dashboard.template.label} şablonu</span>
                <span className="text-[10px] text-slate-400 dark:text-white/35">{dashboard.template.reason}</span>
              </div>
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
              Gelecek Tahmini
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

          {subTab === 'overview' && (
            <>
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
                CSV Raporu
              </button>
            </>
          )}
        </div>
      </div>

      {/* Status Warning / Info */}
      {dashboardError && (
        <div className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{dashboardError}</span>
        </div>
      )}
      {subTab === 'overview' && reportStatus && (
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
      {subTab === 'overview' && !isDashboardLoading && autoInsights && (
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
        subTab === 'forecast' ? (
          <AnalysisStudio
            profile={dashboard.profile}
            datasetFilename={dashboard.datasetFilename}
            datasetCount={dashboard.datasetCount}
            isDark={isDark}
          />
        ) : dashboard.widgets.length === 0 ? (
          <div className="min-h-[380px] flex flex-col items-center justify-center text-center border border-dashed border-slate-300 dark:border-white/10 rounded-3xl bg-white dark:bg-white/5 px-6">
            <LineIcon className="w-12 h-12 text-slate-400 dark:text-[#FFD700] mb-4" />
            <h3 className="text-lg font-bold text-slate-800 dark:text-white uppercase tracking-tight">Analiz Edilecek Veri Bekleniyor</h3>
            <p className="text-sm text-slate-500 dark:text-white/50 max-w-md mt-2 leading-relaxed">{dashboard.emptyState}</p>
          </div>
        ) : (
          /* OVERVIEW TAB */
          <div className="space-y-4">
            {isEditMode && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-indigo-300 bg-indigo-50/50 p-3 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/5">
                <span className="mr-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-white/45">Görünür kartlar</span>
                {dashboard.widgets.map((widget) => (
                  <label key={widget.id} className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-bold dark:border-white/10 dark:bg-black/20">
                    <input type="checkbox" checked={!hiddenWidgetIds.includes(widget.id)} onChange={() => toggleWidgetVisibility(widget.id)} />
                    {widget.title}
                  </label>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {widgets.filter((widget) => !hiddenWidgetIds.includes(widget.id)).map((widget) => (
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
          </div>
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
