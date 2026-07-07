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
      <div className="border-b border-white/5 pb-3 md:pb-4">
        <h2 className="text-2xl md:text-4xl font-black uppercase tracking-tighter">Veri <span className="text-[#FFD700] italic">Tahmini</span></h2>
        <p className="text-[10px] md:text-sm opacity-40 font-mono mt-1 md:mt-2 uppercase tracking-widest">{status}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-6">
        <div className="p-4 md:p-6 bg-white/5 rounded-2xl border border-white/5">
          <div className="flex justify-between mb-2 md:mb-4">
            <div className="text-[8px] md:text-[10px] uppercase tracking-[0.3em] opacity-40">Tahmin Güveni</div>
            <div className="px-1.5 py-0.5 bg-indigo-500/20 text-indigo-400 text-[8px] md:text-[10px] font-black uppercase border border-indigo-500/30 rounded-sm">TREND</div>
          </div>
          <p className="text-3xl md:text-5xl font-black tracking-tighter text-[#FFD700]">{forecast.accuracy}%</p>
          <div className="mt-2 md:mt-4 text-[9px] md:text-[10px] font-mono opacity-40 uppercase tracking-widest">Geçmiş eğilime göre</div>
        </div>

        <div className="p-4 md:p-6 bg-white/5 rounded-2xl border border-white/5">
          <div className="flex justify-between mb-2 md:mb-4">
            <div className="text-[8px] md:text-[10px] uppercase tracking-[0.3em] opacity-40">Kullanılan Alan</div>
            <div className="px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 text-[8px] md:text-[10px] font-black uppercase border border-emerald-500/30 rounded-sm">HEDEF</div>
          </div>
          <p className="text-3xl md:text-5xl font-black tracking-tighter text-emerald-400">{forecast.featureCount}</p>
          <div className="mt-2 md:mt-4 text-[9px] md:text-[10px] font-mono opacity-40 uppercase tracking-widest">{forecast.targetColumn || 'Tahmin alanı yok'}</div>
        </div>

        <div className="p-4 md:p-6 bg-white/5 rounded-2xl border border-white/5">
          <div className="flex justify-between mb-2 md:mb-4">
            <div className="text-[8px] md:text-[10px] uppercase tracking-[0.3em] opacity-40">Geçmiş Veri</div>
            <div className="px-1.5 py-0.5 bg-pink-500/20 text-pink-400 text-[8px] md:text-[10px] font-black uppercase border border-pink-500/30 rounded-sm">SATIR</div>
          </div>
          <p className="text-3xl md:text-5xl font-black tracking-tighter text-pink-400">{forecast.trainRows}</p>
          <div className="mt-2 md:mt-4 text-[9px] md:text-[10px] font-mono opacity-40 uppercase tracking-widest">Tahmin için okundu</div>
        </div>

        <div className="p-4 md:p-6 bg-white/5 rounded-2xl border border-white/5">
          <div className="flex justify-between mb-2 md:mb-4">
            <div className="text-[8px] md:text-[10px] uppercase tracking-[0.3em] opacity-40">Sıra Dışı</div>
            <div className="px-1.5 py-0.5 bg-cyan-500/20 text-cyan-400 text-[8px] md:text-[10px] font-black uppercase border border-cyan-500/30 rounded-sm">UYARI</div>
          </div>
          <p className="text-3xl md:text-5xl font-black tracking-tighter text-cyan-400">{forecast.anomalies.length}</p>
          <div className="mt-2 md:mt-4 text-[9px] md:text-[10px] font-mono opacity-40 uppercase tracking-widest">Bulgu</div>
        </div>
      </div>

      <div className="bg-white/5 p-4 md:p-8 rounded-2xl md:rounded-3xl border border-white/5 mt-1 md:mt-4">
        <h3 className="text-sm md:text-xl font-bold uppercase tracking-tight mb-2">Gerçekleşen Değer ve Tahmin</h3>
        <div className="flex items-center gap-4 mb-4 md:mb-8 text-[10px] md:text-xs font-bold uppercase tracking-widest opacity-60">
          <span className="flex items-center gap-2"><span className="h-0.5 w-5 bg-white" /> Gerçekleşen</span>
          <span className="flex items-center gap-2"><span className="h-0.5 w-5 border-t-2 border-dashed border-[#FFD700]" /> Tahmin</span>
        </div>
        <div className="h-[220px] md:h-[400px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData.length > 0 ? chartData : [{ row: 'Veri yok', actual: 0, predicted: 0 }]} margin={{ top: 20, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#333" />
              <XAxis dataKey="row" axisLine={false} tickLine={false} tick={{fill: '#888', fontSize: 10, fontFamily: 'monospace'}} />
              <YAxis axisLine={false} tickLine={false} tick={{fill: '#888', fontSize: 10, fontFamily: 'monospace'}} />
              <Tooltip 
                contentStyle={{backgroundColor: '#111', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontSize: '12px'}} 
                formatter={(value: any, name: string) => [value, name === 'actual' ? 'Gerçekleşen' : 'Tahmin']}
              />
              <Line type="monotone" dataKey="actual" stroke="#fff" strokeWidth={3} dot={{r: 4, fill: '#fff'}} name="Gerçekleşen" />
              <Line type="monotone" dataKey="predicted" stroke="#FFD700" strokeWidth={3} strokeDasharray="5 5" dot={{r: 4, fill: '#FFD700'}} name="Tahmin" />
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
