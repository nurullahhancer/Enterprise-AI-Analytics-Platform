import React, { useState } from 'react';
import { FileText, Download } from 'lucide-react';
import { downloadReport, ReportType } from '../lib/reports';

export default function Reports() {
  const [status, setStatus] = useState('');
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
    downloadReport(reportConfig.type);
    setStatus(`${reportConfig.title} İndirilenler klasörüne gönderildi.`);
  };

  return (
    <div className="p-4 md:p-12 flex-1 flex flex-col gap-4 md:gap-8 overflow-y-auto max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="border-b border-white/5 pb-3 md:pb-4">
        <div>
          <h2 className="text-2xl md:text-4xl font-black uppercase tracking-tighter">Raporlar</h2>
          <p className="text-[10px] md:text-sm opacity-40 font-mono mt-1 md:mt-2 uppercase tracking-widest">İndirebileceğiniz rapor türleri ve içerikleri.</p>
        </div>
      </div>

      {status && (
        <div className="bg-[#FFD700]/10 border border-[#FFD700]/20 text-[#FFD700] rounded-2xl px-4 py-3 text-xs font-bold uppercase tracking-widest">
          {status}
        </div>
      )}

      {/* Report List - Card style on mobile */}
      <div className="flex flex-col gap-3 md:gap-0 md:bg-white/5 md:border md:border-white/5 md:rounded-3xl md:overflow-hidden">
        {/* Reports */}
        <div className="flex flex-col gap-3 md:gap-0 md:divide-y md:divide-white/5">
          {reports.map((report) => (
            <div key={report.id} className="bg-white/5 md:bg-transparent p-4 md:p-6 rounded-2xl md:rounded-none border border-white/5 md:border-0 flex items-center justify-between hover:bg-white/5 transition-colors active:bg-white/10">
              <div className="flex items-center gap-3 md:gap-6 flex-1 min-w-0">
                <div className="w-10 h-10 md:w-14 md:h-14 rounded-xl flex items-center justify-center border shadow-lg shrink-0 bg-pink-500/10 border-pink-500/20 text-pink-400">
                  <FileText className="w-5 h-5 md:w-7 md:h-7" />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-sm md:text-lg font-bold uppercase tracking-tight truncate">{report.title}</h4>
                  <p className="text-[9px] md:text-xs opacity-50 truncate mt-0.5">{report.details}</p>
                  <div className="flex items-center gap-2 md:gap-4 mt-1.5 text-[9px] md:text-[10px] font-mono opacity-40 uppercase tracking-widest">
                    <span>{report.date}</span>
                    <span className="w-1 h-1 bg-white/40 rounded-full"></span>
                    <span>{report.size}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={() => createReport(report)}
                className="px-3 py-2 md:px-4 md:py-2.5 text-[#FFD700] bg-[#FFD700]/10 border border-[#FFD700]/20 rounded-full transition-all shrink-0 ml-2 flex items-center gap-2 active:scale-95"
                aria-label={`${report.title} indir`}
              >
                <Download className="w-4 h-4 md:w-5 md:h-5" />
                <span className="hidden sm:inline text-[10px] md:text-xs font-bold uppercase tracking-widest">{report.buttonLabel}</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
