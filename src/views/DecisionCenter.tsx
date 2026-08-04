import React, { useEffect, useState, useCallback } from 'react';
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
import type { BusinessRiskSignal, BusinessOpportunitySignal, BIEngineEvaluationResult } from '../server/bi/types';
import { apiFetch, authHeaders, getApiUrl } from '../lib/api';

interface DecisionCenterProps {
  user: User;
}

interface NlpClusterItem {
  topic: string;
  count: number;
  percentage: number;
}

interface NlpData {
  hasComments: boolean;
  totalComments: number;
  topComplaint: NlpClusterItem | null;
  clusters: NlpClusterItem[];
  columnHeader: string | null;
}

export const DecisionCenter: React.FC<DecisionCenterProps> = () => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [datasetFilename, setDatasetFilename] = useState<string | null>(null);
  const [nlpData, setNlpData] = useState<NlpData | null>(null);

  const [biResult, setBiResult] = useState<BIEngineEvaluationResult>(() =>
    BIEngine.evaluate({})
  );

  const loadData = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const response = await apiFetch(getApiUrl('/api/dashboard/dynamic'), {
        headers: authHeaders(),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.biResult) {
          setBiResult(data.biResult);
        }
        if (data.nlp) {
          setNlpData(data.nlp);
        }
        setDatasetFilename(data.datasetFilename || null);
      }
    } catch (err) {
      console.error('DecisionCenter veri yükleme hatası:', err);
    } finally {
      setIsRefreshing(false);
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleRefresh = () => {
    void loadData();
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
            {datasetFilename ? (
              <span>Aktif Analiz Grubu: <strong className="text-white">{datasetFilename}</strong></span>
            ) : (
              <span>Sistemimiz ham veri tablosu göstermez; ML tahminleri ve BI Engine ile veriye dayalı riskleri ve aksiyon önerilerini sunar.</span>
            )}
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
              <ShieldAlert className="w-5 h-5 text-red-400" /> {biResult.overallHealthStatus === 'CRITICAL' ? 'Kritik Riskli' : biResult.overallHealthStatus === 'AT_RISK' ? 'Riskli Durum' : 'İyi Durum'}
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
          <div className="text-xs font-medium text-slate-400">Erken Uyarı & Riskler</div>
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
          {biResult.riskSignals.length > 0 ? (
            <span>
              Aktif veri setinizdeki analiz sonuçlarına göre <strong>{biResult.summaryCounts.criticalCount} kritik risk</strong> ve <strong>{biResult.summaryCounts.warningCount} uyarı sinyali</strong> tespit edilmiştir. En öncelikli aksiyon: <strong>{biResult.riskSignals[0].title}</strong>. Veriye dayalı kanıt: {biResult.riskSignals[0].evidence}
            </span>
          ) : (
            <span>
              Yüklenen aktif veri seti üzerinde kritik risk sinyali tespit edilmemiştir. Veri kümenizdeki metrikler stabil görünmektedir.
            </span>
          )}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-slate-400 border-t border-slate-800/80 pt-3">
          <span className="flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> ML Modelleri: XGBoost, SARIMAX, TF-IDF</span>
          <span className="flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> BI Engine: Dinamik Kural Analizi Yapıldı</span>
        </div>
      </div>

      {/* Main Section: Decision Cards */}
      <div className="space-y-4">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-red-400" /> Tespiti Yapılan Kritik İş Riskleri & Aksiyonlar
        </h2>

        {biResult.riskSignals.length === 0 ? (
          <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 text-slate-400 text-sm text-center">
            Aktif veri setinizde tespiti yapılan kritik bir risk sinyali bulunmamaktadır.
          </div>
        ) : (
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
        )}
      </div>

      {/* NLP Reviews & Feedback Complaints Cluster */}
      <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-indigo-400" /> Customer Review NLP Complaint Clusters
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {nlpData?.hasComments ? (
                <span>NLP Katmanı tarafından <strong>{nlpData.totalComments.toLocaleString('tr-TR')} yorum</strong> (Kolon: <code className="text-indigo-300">{nlpData.columnHeader}</code>) otomatik analiz edilmiş ve ana konulara göre kümelenmiştir.</span>
              ) : (
                <span>Aktif veri setiniz için metin/yorum analizi görünümü.</span>
              )}
            </p>
          </div>
          <span className="text-xs px-3 py-1 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800">
            TF-IDF + KMeans NLP Engine
          </span>
        </div>

        {nlpData?.hasComments && nlpData.clusters.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            {nlpData.clusters.slice(0, 3).map((item, idx) => (
              <div key={item.topic} className={`p-4 rounded-xl bg-slate-950/80 border space-y-2 ${idx === 0 ? 'border-red-500/20' : 'border-amber-500/20'}`}>
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Şikayet Konusu #{idx + 1}</span>
                  <span className={`font-bold ${idx === 0 ? 'text-red-400' : 'text-amber-400'}`}>%{item.percentage}</span>
                </div>
                <div className="text-sm font-bold text-white">{item.topic}</div>
                <div className="text-xs text-slate-400">{item.count} Müşteri Yorumu</div>
                <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${idx === 0 ? 'bg-red-500' : 'bg-amber-500'}`} style={{ width: `${Math.min(100, item.percentage)}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-5 rounded-xl bg-slate-950/80 border border-slate-800 text-slate-400 text-sm leading-relaxed">
            Aktif yüklenen veri setinde (veya birleşik dosyalarda) müşteri yorum/metin kolonu tespit edilmedi.
            Eski yorum veri setini çıkardıysanız veya başka bir veri seti eklediyseniz, yorum analizi için metin/şikayet kolonu içeren bir CSV/Excel dosyasını <strong className="text-indigo-300">Verilerim</strong> sayfasından yükleyebilirsiniz.
          </div>
        )}
      </div>
    </div>
  );
};

export default DecisionCenter;


