import React, { useState } from 'react';
import { FileText, Download } from 'lucide-react';
import { downloadReport, ReportType } from '../lib/reports';

export default function Reports() {
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const reports = [
    { 
      id: 'dashboard-summary',
      type: 'dashboard' as ReportType,
      title: 'Dashboard Özet Raporu',
      buttonLabel: 'Özet Raporu İndir',
      date: 'Güncel veri',
      size: 'CSV',
      details: 'Toplam ciro, maliyet, risk oranı, brüt kar ve veri satır sayısı.',
      rows: [
        { metric: 'Rapor İçeriği', value: 'Dashboard özet metrikleri' },
        { metric: 'Kapsam', value: 'Ciro, maliyet, risk, brüt kar, satır sayısı' }
      ]
    },
    { 
      id: 'prediction-summary',
      type: 'prediction' as ReportType,
      title: 'Tahmin ve Anomali Raporu',
      buttonLabel: 'Tahmin Raporu İndir',
      date: 'Güncel veri',
      size: 'CSV',
      details: 'Model tahmini, hedef kolon, tahmin serisi ve aykırı değer özeti.',
      rows: [
        { metric: 'Rapor İçeriği', value: 'Makine öğrenmesi tahmin özeti' },
        { metric: 'Kapsam', value: 'Model skoru, hedef kolon, tahminler, anomaliler' }
      ]
    },
    {
      id: 'auto-insights',
      type: 'insights' as ReportType,
      title: 'Otomatik İçgörü Raporu',
      buttonLabel: 'İçgörü Raporu İndir',
      date: 'Rapora eklenenler',
      size: 'CSV',
      details: 'Dashboard üzerinden rapora eklediğiniz içgörü ve aksiyon maddeleri.',
      rows: []
    },
    {
      id: 'data-quality',
      type: 'quality' as ReportType,
      title: 'Veri Kalite Raporu',
      buttonLabel: 'Kalite Raporu İndir',
      date: 'Güncel veri',
      size: 'CSV',
      details: 'Yüklenen verinin satır/kolon durumu ve analiz için hazır olma özeti.',
      rows: [
        { metric: 'Rapor İçeriği', value: 'Veri kalite özeti' },
        { metric: 'Kapsam', value: 'Satır, kolon, analiz uygunluğu' }
      ]
    },
  ];

  const createReport = async (reportConfig = reports[0]) => {
    setDownloadingId(reportConfig.id);
    setStatus(null);
    try {
      await downloadReport(reportConfig.type);
      setStatus({ type: 'success', text: `${reportConfig.title} başarıyla indirildi.` });
    } catch (error) {
      setStatus({
        type: 'error',
        text: error instanceof Error ? error.message : 'Rapor indirilemedi.'
      });
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="p-4 md:p-12 flex-1 flex flex-col gap-4 md:gap-8 overflow-y-auto max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="border-b border-slate-200 pb-3 md:pb-4 dark:border-white/5">
        <div>
          <h2 className="text-2xl md:text-4xl font-black uppercase tracking-tighter">Raporlar</h2>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-slate-500 md:mt-2 md:text-sm dark:text-white/40">İndirebileceğiniz rapor türleri ve içerikleri.</p>
        </div>
      </div>

      {status && (
        <div
          role={status.type === 'error' ? 'alert' : 'status'}
          aria-live="polite"
          className={status.type === 'error'
            ? 'bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-2xl px-4 py-3 text-xs font-bold uppercase tracking-widest'
            : 'rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs font-bold uppercase tracking-widest text-indigo-700 dark:border-[#FFD700]/20 dark:bg-[#FFD700]/10 dark:text-[#FFD700]'}
        >
          {status.text}
        </div>
      )}

      {/* Report List - Card style on mobile */}
      <div className="flex flex-col gap-3 md:gap-0 md:overflow-hidden md:rounded-3xl md:border md:border-slate-200 md:bg-white dark:md:border-white/5 dark:md:bg-white/5">
        {/* Reports */}
        <div className="flex flex-col gap-3 md:gap-0 md:divide-y md:divide-slate-100 dark:md:divide-white/5">
          {reports.map((report) => (
            <div key={report.id} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white p-4 transition-colors hover:bg-slate-50 active:bg-slate-100 md:rounded-none md:border-0 md:bg-transparent md:p-6 dark:border-white/5 dark:bg-white/5 dark:hover:bg-white/5 dark:active:bg-white/10 dark:md:bg-transparent">
              <div className="flex items-center gap-3 md:gap-6 flex-1 min-w-0">
                <div className="w-10 h-10 md:w-14 md:h-14 rounded-xl flex items-center justify-center border shadow-lg shrink-0 bg-pink-500/10 border-pink-500/20 text-pink-400">
                  <FileText className="w-5 h-5 md:w-7 md:h-7" />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm md:text-lg font-bold uppercase tracking-tight truncate">{report.title}</h4>
                  <p className="mt-0.5 truncate text-[9px] text-slate-500 md:text-xs dark:text-white/50">{report.details}</p>
                  <div className="mt-1.5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-widest text-slate-400 md:gap-4 md:text-[10px] dark:text-white/40">
                    <span>{report.date}</span>
                    <span className="h-1 w-1 rounded-full bg-slate-300 dark:bg-white/40"></span>
                    <span>{report.size}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => createReport(report)}
                disabled={downloadingId !== null}
                className="px-3 py-2 md:px-4 md:py-2.5 text-[#FFD700] bg-[#FFD700]/10 border border-[#FFD700]/20 rounded-full transition-all shrink-0 ml-2 flex items-center gap-2 active:scale-95"
                aria-label={`${report.title} indir`}
              >
                <Download className="w-4 h-4 md:w-5 md:h-5" />
                <span className="hidden sm:inline text-[10px] md:text-xs font-bold uppercase tracking-widest">
                  {downloadingId === report.id ? 'Hazırlanıyor...' : report.buttonLabel}
                </span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
