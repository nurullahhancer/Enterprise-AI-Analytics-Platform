import React, { useEffect, useState } from 'react';
import { UploadCloud, CheckCircle2, AlertCircle, FileSpreadsheet, Trash2, Plus, ArrowRight } from 'lucide-react';
import { useDropzone } from 'react-dropzone';
import { cn } from '../lib/utils';
import { authHeaders, getApiUrl } from '../lib/api';

interface DatasetMeta {
  id: number;
  filename: string;
  row_count: number;
  column_count: number;
  is_active: number;
  warning: string | null;
  created_at: string;
}

export default function DataImport({ onNextView }: { onNextView?: () => void }) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  
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

  const loadDatasets = async () => {
    try {
      const res = await fetch(getApiUrl('/api/dataset/list'), { headers: authHeaders() });
      if (res.ok) setDatasets(await res.json());
    } catch { /* ignore */ } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadDatasets(); }, []);

  const onDrop = async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    setIsUploading(true);
    setUploadStatus('idle');
    setMessage('');

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(getApiUrl('/api/upload'), {
        method: 'POST',
        headers: authHeaders(),
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setUploadStatus('success');
        setMessage(`"${data.filename}" başarıyla yüklendi — ${data.rowCount} satır, ${data.columnCount} kolon.`);
        loadDatasets();
      } else {
        setUploadStatus('error');
        setMessage(data.error?.message || 'Yükleme sırasında hata oluştu.');
      }
    } catch {
      setUploadStatus('error');
      setMessage('Sunucu bağlantı hatası.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (id: number, filename: string) => {
    if (!confirm(`"${filename}" dosyasını silmek istediğinize emin misiniz?`)) return;
    setDeletingId(id);
    try {
      const res = await fetch(getApiUrl(`/api/dataset/${id}`), {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (res.ok) {
        await loadDatasets();
      } else {
        const data = await res.json();
        alert(data.error?.message || 'Silme sırasında hata oluştu.');
      }
    } catch {
      alert('Sunucu bağlantı hatası.');
    } finally {
      setDeletingId(null);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDragEnter: () => undefined,
    onDragLeave: () => undefined,
    onDragOver: () => undefined,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
    },
    multiple: false,
    maxFiles: 1,
  });

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className="p-4 md:p-12 flex-1 flex flex-col gap-6 md:gap-8 max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className={cn(
        "flex flex-col sm:flex-row sm:items-center sm:justify-between pb-5 gap-4 border-b",
        isDark ? "border-white/5" : "border-slate-200"
      )}>
        <div>
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight">Veri Kaynakları</h2>
          <p className="text-xs text-slate-500 dark:text-white/40 mt-1 leading-relaxed">
            Analiz etmek istediğiniz CSV veya Excel dosyalarını buraya yükleyebilir veya mevcut dosyalarınızı yönetebilirsiniz.
          </p>
        </div>
        
        {datasets.length > 0 && onNextView && (
          <button
            onClick={onNextView}
            className={cn(
              "px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 active:scale-95 shadow-sm border shrink-0",
              isDark 
                ? "bg-[#FFD700] border-[#FFD700] text-black hover:bg-[#ffe033]" 
                : "bg-[#4F46E5] border-[#4F46E5] text-white hover:bg-[#4338ca]"
            )}
          >
            Analiz Paneline Git
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Upload zone */}
      <div
        {...getRootProps()}
        className={cn(
          'border-2 border-dashed rounded-3xl p-8 md:p-12 text-center cursor-pointer transition-all duration-300 shadow-sm',
          isDragActive 
            ? (isDark ? 'border-[#FFD700] bg-[#FFD700]/10' : 'border-[#4F46E5] bg-[#4F46E5]/5') 
            : (isDark ? 'border-white/10 bg-white/5 hover:bg-white/[0.07]' : 'border-slate-300 bg-white hover:bg-slate-50/50'),
          isUploading && 'opacity-50 pointer-events-none'
        )}
      >
        <input {...getInputProps()} />
        <div className="flex justify-center mb-4">
          <div className={cn(
            "w-16 h-16 rounded-full flex items-center justify-center border shadow-inner",
            isDark ? "bg-black/40 border-white/5" : "bg-slate-50 border-slate-200"
          )}>
            {isUploading ? (
              <div className={cn(
                "w-7 h-7 border-2 border-t-transparent rounded-full animate-spin",
                isDark ? "border-[#FFD700]/30 border-t-[#FFD700]" : "border-[#4F46E5]/30 border-t-[#4F46E5]"
              )} />
            ) : (
              <UploadCloud className={cn("w-7 h-7", isDark ? "text-[#FFD700]" : "text-[#4F46E5]")} />
            )}
          </div>
        </div>
        <h3 className="text-base md:text-lg font-bold text-slate-800 dark:text-white uppercase tracking-tight mb-2">
          {isDragActive ? 'Dosyayı Buraya Bırakın...' : isUploading ? 'Dosya İşleniyor...' : 'Analiz Edilecek Yeni Dosya Yükle'}
        </h3>
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-white/40 mb-6">
          DESTEKLENEN DOSYA TÜRLERİ: .CSV, .XLSX, .XLS (MAKS. 50 MB)
        </p>
        <button className={cn(
          "inline-flex items-center gap-2 px-5 py-2.5 border rounded-xl text-xs font-bold uppercase tracking-wider transition-all",
          isDark 
            ? "border-[#FFD700]/30 hover:border-[#FFD700] text-[#FFD700] hover:bg-[#FFD700]/5" 
            : "border-[#4F46E5]/30 hover:border-[#4F46E5] text-[#4F46E5] hover:bg-[#4F46E5]/5"
        )}>
          <Plus className="w-4 h-4" /> Dosya Seç
        </button>
      </div>

      {/* Status message */}
      {uploadStatus !== 'idle' && (
        <div className={cn(
          'p-4 rounded-2xl flex items-start gap-3 border shadow-sm',
          uploadStatus === 'success' 
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20' 
            : 'bg-red-50 text-red-700 border-red-200 dark:bg-pink-500/10 dark:text-pink-400 dark:border-pink-500/20'
        )}>
          {uploadStatus === 'success'
            ? <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
            : <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />}
          <p className="text-xs md:text-sm font-semibold">{message}</p>
        </div>
      )}

      {/* Dataset list */}
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-white/60">Yüklenen Dosyalar</h3>
          {datasets.length > 0 && (
            <span className={cn(
              "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border",
              isDark 
                ? "bg-[#FFD700]/10 border-[#FFD700]/20 text-[#FFD700]" 
                : "bg-indigo-50 border-indigo-100 text-[#4F46E5]"
            )}>
              {datasets.length} DOSYA
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-xs text-slate-400 dark:text-white/40 uppercase tracking-wider font-mono">Yükleniyor...</div>
        ) : datasets.length === 0 ? (
          <div className={cn(
            "border border-dashed rounded-2xl p-10 text-center text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-white/40",
            isDark ? "border-white/10 bg-white/5" : "border-slate-200 bg-white"
          )}>
            Henüz yüklenmiş bir veri seti bulunmamaktadır.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {datasets.map((ds) => (
              <div
                key={ds.id}
                className={cn(
                  "border rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition-all shadow-sm",
                  isDark 
                    ? "bg-white/5 border-white/10 hover:bg-white/[0.07]" 
                    : "bg-white border-slate-200/60 hover:border-slate-300"
                )}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <div className={cn(
                    "w-12 h-12 border rounded-xl flex items-center justify-center shrink-0 shadow-sm",
                    isDark 
                      ? "bg-[#FFD700]/10 border-[#FFD700]/20 text-[#FFD700]" 
                      : "bg-indigo-50 border-indigo-100 text-[#4F46E5]"
                  )}>
                    <FileSpreadsheet className="w-6 h-6" />
                  </div>
                  <div className="min-w-0">
                    <h4 className="text-sm md:text-base font-bold text-slate-800 dark:text-white truncate">{ds.filename}</h4>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-slate-400 dark:text-white/40 mt-1">
                      {ds.row_count.toLocaleString('tr-TR')} satır · {ds.column_count} kolon · {formatDate(ds.created_at)}
                    </p>
                    {ds.warning && (
                      <p className="text-[10px] text-amber-500 mt-1">{ds.warning}</p>
                    )}
                  </div>
                </div>
                <div className="shrink-0 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => handleDelete(ds.id, ds.filename)}
                    disabled={deletingId === ds.id}
                    className="px-4 py-2 bg-red-500/5 dark:bg-pink-500/10 border border-red-500/20 dark:border-pink-500/20 hover:bg-red-500/10 dark:hover:bg-pink-500/20 text-red-600 dark:text-pink-400 rounded-xl text-xs font-bold uppercase tracking-wider flex items-center gap-2 active:scale-95 transition-all disabled:opacity-50"
                  >
                    {deletingId === ds.id ? (
                      <div className="w-4 h-4 border-2 border-red-500/30 border-t-red-500 rounded-full animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                    Sil
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
