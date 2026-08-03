import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  TrendingUp,
  PackageX,
  DollarSign,
  ShoppingCart,
  MessageSquare,
  ShieldAlert,
  Zap,
  ArrowUpRight,
  RefreshCw,
  Sparkles,
  Info,
  Layers,
  ChevronRight,
} from 'lucide-react';
import type { User } from '../types';
import { BIEngine } from '../server/bi/engine';
import type { BusinessRiskSignal, BusinessOpportunitySignal } from '../server/bi/types';

interface DecisionCenterProps {
  user: User;
}

export const DecisionCenter: React.FC<DecisionCenterProps> = () => {
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Mock domain state from ML + BI Engine for display demonstration
  const [biResult, setBiResult] = useState(() =>
    BIEngine.evaluate({
      inventoryDays: 5,
      skuInventory: [
        { sku: 'SKU-8492', name: 'Kablosuz Kulaklık V2', stockDays: 4, stockQty: 24, dailyVelocity: 6 },
        { sku: 'SKU-3104', name: 'Akıllı Saat Pro', stockDays: 11, stockQty: 55, dailyVelocity: 5 },
      ],
      profitMarginPct: 0.11, // 11%
      roas: 1.8, // Inefficient
      returnRatePct: 0.092, // 9.2%
      cashFlow30dForecast: -45000,
      churnRatePct: 0.12,
      nlpTopComplaint: { topic: 'Kargo ve Teslimat Gecikmesi', count: 430, percentage: 30.2 },
      salesGrowthVsLastWeekPct: 14,
    })
  );

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => {
      setBiResult(
        BIEngine.evaluate({
          inventoryDays: 6,
          skuInventory: [
            { sku: 'SKU-8492', name: 'Kablosuz Kulaklık V2', stockDays: 5, stockQty: 30, dailyVelocity: 6 },
            { sku: 'SKU-3104', name: 'Akıllı Saat Pro', stockDays: 14, stockQty: 70, dailyVelocity: 5 },
          ],
          profitMarginPct: 0.12,
          roas: 1.9,
          returnRatePct: 0.088,
          cashFlow30dForecast: -32000,
          churnRatePct: 0.11,
          nlpTopComplaint: { topic: 'Kargo ve Teslimat Gecikmesi', count: 410, percentage: 29.5 },
          salesGrowthVsLastWeekPct: 16,
        })
      );
      setIsRefreshing(false);
    }, 600);
  };

  const getSeverityBadge = (severity: string) => {
    switch (severity) {
      case 'CRITICAL':
        return <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-red-500/15 text-red-400 border border-red-500/30 flex items-center gap-1"><ShieldAlert className="w-3.5 h-3.5" /> KRİTİK RİSK</span>;
      case 'WARNING':
        return <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> UYARI</span>;
      default:
        return <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30 flex items-center gap-1"><Info className="w-3.5 h-3.5" /> BİLGİ</span>;
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8 text-slate-100">
      {/* Header & Vision Banner */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 p-6 rounded-2xl border border-indigo-500/20 shadow-xl">
        <div>
          <div className="flex items-center gap-2 text-indigo-400 text-xs font-bold uppercase tracking-wider mb-1">
            <Zap className="w-4 h-4" /> Dijital AI İş Analisti & Karar Destek Sistemi (DSS)
          </div>
          <h1 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight">
            E-Ticaret & Muhasebe Karar Merkezi
          </h1>
          <p className="text-sm text-slate-400 mt-1 max-w-2xl">
            Sistemimiz ham veri tablosu göstermez; ML tahminleri ve Business Intelligence Engine ile hesaplanan veriye dayalı riskleri, fırsatları ve aksiyon önerilerini sunar.
          </p>
        </div>

        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          {isRefreshing ? 'Kararlar Yenileniyor...' : 'Kararları Yenile'}
        </button>
      </div>

      {/* Status Summary KPI Bar */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-sm">
          <div className="text-xs font-medium text-slate-400">Genel Sağlık Durumu</div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xl font-bold text-red-400 flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-red-400" /> Riskli Durum
            </span>
            <span className="text-xs px-2 py-1 rounded-md bg-red-950/60 text-red-400 border border-red-800">
              {biResult.summaryCounts.criticalCount} Kritik Sinyal
            </span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-sm">
          <div className="text-xs font-medium text-slate-400">Kritik İş Riskleri</div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-2xl font-extrabold text-white">{biResult.summaryCounts.criticalCount}</span>
            <span className="text-xs text-slate-400">Deterministik Kural</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-sm">
          <div className="text-xs font-medium text-slate-400">Erken Uarı & Riskler</div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-2xl font-extrabold text-amber-400">{biResult.summaryCounts.warningCount}</span>
            <span className="text-xs text-amber-400/80">Takip Edilmeli</span>
          </div>
        </div>

        <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-sm">
          <div className="text-xs font-medium text-slate-400">Büyüme Fırsatları</div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-2xl font-extrabold text-emerald-400">{biResult.summaryCounts.opportunityCount}</span>
            <span className="text-xs text-emerald-400/80">Aksiyon Bekliyor</span>
          </div>
        </div>
      </div>

      {/* AI Explainer Executive Digest */}
      <div className="p-6 rounded-2xl bg-gradient-to-br from-indigo-950/50 via-slate-900 to-slate-900 border border-indigo-500/30 relative overflow-hidden shadow-xl">
        <div className="flex items-center gap-2 text-indigo-300 font-semibold mb-3">
          <Sparkles className="w-5 h-5 text-indigo-400" /> Dijital AI Analist Yönetici Özeti
        </div>
        <p className="text-slate-200 text-sm leading-relaxed">
          "İşletmenizdeki en kritik risk <strong>stok tükenmesi</strong> ve <strong>negatif nakit akışı</strong> olarak tespit edilmiştir. Son 30 gündeki günlük 6 adetlik satış hızına göre <strong>SKU-8492 (Kablosuz Kulaklık V2)</strong> stokları 5 gün içinde tükenecektir (%89 güven skoru). Ayrıca, 30 günlük nakit akışı projeksiyonunuz <strong>-32.000 TL</strong> açık vermektedir. Reklam harcamalarınızdaki düşük ROAS (1.9x) nedeniyle bütçenin yeniden dağıtılması ve tedarik siparişinin acilen verilmesi önerilmektedir."
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-400 border-t border-slate-800/80 pt-3">
          <span className="flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> ML Modelleri: XGBoost, SARIMAX, TF-IDF</span>
          <span className="flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> BI Engine: 7 Temel Kural Değerlendirildi</span>
        </div>
      </div>

      {/* Main Section: Decision Cards */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-red-400" /> Tespiti Yapılan Kritik İş Riskleri & Aksiyonlar
        </h2>

        <div className="grid grid-cols-1 gap-4">
          {biResult.riskSignals.map((signal: BusinessRiskSignal) => (
            <div
              key={signal.id}
              className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 transition-all shadow-lg space-y-4"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {getSeverityBadge(signal.severity)}
                  <h3 className="text-base font-bold text-white">{signal.title}</h3>
                </div>
                <div className="text-xs text-slate-400 bg-slate-800/60 px-3 py-1 rounded-lg border border-slate-700/50">
                  Tetiklenen Kural: <span className="font-mono text-indigo-300">{signal.conditionTriggered}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-950/60 p-4 rounded-xl border border-slate-800/60">
                <div>
                  <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                    🔍 Veriye Dayalı Kanıt
                  </span>
                  <p className="text-sm text-slate-200">{signal.evidence}</p>
                </div>
                <div>
                  <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wider block mb-1">
                    🎯 Önerilen Aksiyon
                  </span>
                  <p className="text-sm text-indigo-200 font-medium">{signal.actionRequired}</p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-1">
                <button className="px-4 py-2 text-xs font-semibold rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors flex items-center gap-1.5 shadow-md shadow-indigo-600/10">
                  Aksiyonu Başlat <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* NLP Reviews & Feedback Complaints Cluster */}
      <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-indigo-400" /> Customer Review NLP Complaint Clusters
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              NLP Katmanı tarafından 1.420 yorum otomatik analiz edilmiş ve ana problem konularına göre kümelenmiştir.
            </p>
          </div>
          <span className="text-xs px-3 py-1 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800">
            TF-IDF + KMeans NLP Engine
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          <div className="p-4 rounded-xl bg-slate-950/80 border border-red-500/20 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Şikayet Konusu #1</span>
              <span className="text-red-400 font-bold">%30.2</span>
            </div>
            <div className="text-sm font-bold text-white">Kargo & Teslimat Gecikmesi</div>
            <div className="text-xs text-slate-400">430 Müşteri Yorumu</div>
            <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div className="bg-red-500 h-full rounded-full" style={{ width: '30.2%' }}></div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950/80 border border-amber-500/20 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Şikayet Konusu #2</span>
              <span className="text-amber-400 font-bold">%8.5</span>
            </div>
            <div className="text-sm font-bold text-white">Beden / Ebat Uyuşmazlığı</div>
            <div className="text-xs text-slate-400">120 Müşteri Yorumu</div>
            <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div className="bg-amber-500 h-full rounded-full" style={{ width: '8.5%' }}></div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-950/80 border border-amber-500/20 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Şikayet Konusu #3</span>
              <span className="text-amber-400 font-bold">%6.7</span>
            </div>
            <div className="text-sm font-bold text-white">Ambalaj / Paket Kutusunda Hasar</div>
            <div className="text-xs text-slate-400">95 Müşteri Yorumu</div>
            <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
              <div className="bg-amber-500 h-full rounded-full" style={{ width: '6.7%' }}></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DecisionCenter;

