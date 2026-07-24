import React, { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { authHeaders, getApiUrl } from '../lib/api';

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

export default function Predictions() {
  const [forecast, setForecast] = useState<MlForecast>(emptyForecast);
  const [status, setStatus] = useState('Tahmin için veri bekleniyor.');

  useEffect(() => {
    const loadForecast = async () => {
      try {
        const response = await fetch(getApiUrl('/api/ml/forecast'), { headers: authHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || 'Tahmin alınamadı.');
        setForecast(data);
        setStatus(`${data.targetColumn || 'ilk sayısal alan'} için gelecek değerler hesaplandı.`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Tahmin alınamadı.');
      }
    };

    loadForecast();
  }, []);

  const chartData = [
    ...forecast.series,
    ...forecast.forecast.map((point) => ({ row: point.row, actual: null, predicted: point.predicted }))
  ];

  return (
    <div className="p-4 md:p-12 flex-1 flex flex-col gap-4 md:gap-8 overflow-y-auto">
      <div className="border-b border-slate-200 pb-3 md:pb-4 dark:border-white/5">
        <h2 className="text-2xl font-black uppercase tracking-tighter text-slate-950 md:text-4xl dark:text-white">Veri <span className="text-indigo-600 italic dark:text-[#FFD700]">Tahmini</span></h2>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-slate-500 md:mt-2 md:text-sm dark:text-white/40">{status}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6 dark:border-white/5 dark:bg-white/5">
          <div className="flex justify-between mb-2 md:mb-4">
            <div className="text-[8px] uppercase tracking-[0.3em] text-slate-500 md:text-[10px] dark:text-white/40">Heuristik Uyum Skoru</div>
            <div className="rounded-sm border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[8px] font-black uppercase text-indigo-600 md:text-[10px] dark:border-indigo-500/30 dark:bg-indigo-500/20 dark:text-indigo-400">TREND</div>
          </div>
          <p className="text-3xl font-black tracking-tighter text-indigo-600 md:text-5xl dark:text-[#FFD700]">{forecast.accuracy}%</p>
          <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-slate-500 md:mt-4 md:text-[10px] dark:text-white/40">Geçmiş eğilime göre</div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6 dark:border-white/5 dark:bg-white/5">
          <div className="flex justify-between mb-2 md:mb-4">
            <div className="text-[8px] uppercase tracking-[0.3em] text-slate-500 md:text-[10px] dark:text-white/40">Kullanılan Alan</div>
            <div className="rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[8px] font-black uppercase text-emerald-600 md:text-[10px] dark:border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-400">HEDEF</div>
          </div>
          <p className="text-3xl font-black tracking-tighter text-emerald-600 md:text-5xl dark:text-emerald-400">{forecast.featureCount}</p>
          <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-slate-500 md:mt-4 md:text-[10px] dark:text-white/40">{forecast.targetColumn || 'Tahmin alanı yok'}</div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6 dark:border-white/5 dark:bg-white/5">
          <div className="flex justify-between mb-2 md:mb-4">
            <div className="text-[8px] uppercase tracking-[0.3em] text-slate-500 md:text-[10px] dark:text-white/40">Geçmiş Veri</div>
            <div className="px-1.5 py-0.5 bg-pink-500/20 text-pink-400 text-[8px] md:text-[10px] font-black uppercase border border-pink-500/30 rounded-sm">SATIR</div>
          </div>
          <p className="text-3xl font-black tracking-tighter text-pink-600 md:text-5xl dark:text-pink-400">{forecast.trainRows}</p>
          <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-slate-500 md:mt-4 md:text-[10px] dark:text-white/40">Tahmin için okundu</div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6 dark:border-white/5 dark:bg-white/5">
          <div className="flex justify-between mb-2 md:mb-4">
            <div className="text-[8px] uppercase tracking-[0.3em] text-slate-500 md:text-[10px] dark:text-white/40">Sıra Dışı</div>
            <div className="px-1.5 py-0.5 bg-cyan-500/20 text-cyan-400 text-[8px] md:text-[10px] font-black uppercase border border-cyan-500/30 rounded-sm">UYARI</div>
          </div>
          <p className="text-3xl font-black tracking-tighter text-cyan-600 md:text-5xl dark:text-cyan-400">{forecast.anomalies.length}</p>
          <div className="mt-2 font-mono text-[9px] uppercase tracking-widest text-slate-500 md:mt-4 md:text-[10px] dark:text-white/40">Bulgu</div>
        </div>
      </div>

      <div className="mt-1 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:mt-4 md:rounded-3xl md:p-8 dark:border-white/5 dark:bg-white/5">
        <h3 className="mb-2 text-sm font-bold uppercase tracking-tight text-slate-900 md:text-xl dark:text-white">Gerçekleşen Değer ve Tahmin</h3>
        <div className="mb-4 flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-slate-500 md:mb-8 md:text-xs dark:text-white/60">
          <span className="flex items-center gap-2"><span className="h-0.5 w-5 bg-slate-700 dark:bg-white" /> Gerçekleşen</span>
          <span className="flex items-center gap-2"><span className="h-0.5 w-5 border-t-2 border-dashed border-indigo-600 dark:border-[#FFD700]" /> Tahmin</span>
        </div>
        <div className="h-[220px] md:h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData.length > 0 ? chartData : [{ row: 'Veri yok', actual: 0, predicted: 0 }]} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-color)" />
              <XAxis dataKey="row" axisLine={false} tickLine={false} tick={{fill: 'var(--text-secondary)', fontSize: 10, fontFamily: 'monospace'}} />
              <YAxis axisLine={false} tickLine={false} tick={{fill: 'var(--text-secondary)', fontSize: 10, fontFamily: 'monospace'}} />
              <Tooltip 
                contentStyle={{backgroundColor: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border-color)', color: 'var(--text-primary)', fontSize: '12px'}}
                formatter={(value: any, name: string) => [value, name === 'actual' ? 'Gerçekleşen' : 'Tahmin']}
              />
              <Line type="monotone" dataKey="actual" stroke="var(--text-primary)" strokeWidth={3} dot={{r: 4, fill: 'var(--text-primary)'}} name="Gerçekleşen" />
              <Line type="monotone" dataKey="predicted" stroke="var(--accent-color)" strokeWidth={3} strokeDasharray="5 5" dot={{r: 4, fill: 'var(--accent-color)'}} name="Tahmin" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {forecast.anomalies.length > 0 && (
        <div className="bg-pink-500/10 border border-pink-500/20 rounded-2xl p-4">
          <h3 className="text-sm font-black uppercase tracking-widest text-pink-400 mb-3">Sıra Dışı Değerler</h3>
          <div className="space-y-2">
            {forecast.anomalies.map((item) => (
              <div key={item.name} className="flex justify-between text-sm">
                <span>{item.name}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
