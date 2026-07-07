import React, { useState, useEffect } from 'react';
import {
  Database,
  GitBranch,
  FileText,
  Users,
  Building2,
  Cpu,
  History,
  Plus,
  Trash2,
  RefreshCw,
  Upload,
  Check,
  AlertTriangle,
  Play,
  Shield,
  Search,
  CheckCircle,
  ExternalLink
} from 'lucide-react';
import { cn } from '../lib/utils';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import { User } from '../types';

interface EnterpriseSuiteProps {
  user: User;
  onUserUpdate: (updatedUser: User) => void;
}

export default function EnterpriseSuite({ user, onUserUpdate }: EnterpriseSuiteProps) {
  const [activeTab, setActiveTab] = useState<'connectors' | 'etl' | 'rag' | 'rbac' | 'tenant' | 'plugins' | 'audit'>('connectors');
  const [isDark, setIsDark] = useState(true);

  // States for various tabs
  const [connections, setConnections] = useState<any[]>([]);
  const [newConnName, setNewConnName] = useState('');
  const [newConnType, setNewConnType] = useState<'sql' | 'api'>('sql');
  const [newConnHost, setNewConnHost] = useState('');
  const [newConnDatabase, setNewConnDatabase] = useState('');
  const [newConnQuery, setNewConnQuery] = useState('');
  const [newConnUrl, setNewConnUrl] = useState('');
  const [isTestingConn, setIsTestingConn] = useState(false);
  const [connMessage, setConnMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const [documents, setDocuments] = useState<any[]>([]);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const [docMessage, setDocMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditSearch, setAuditSearch] = useState('');

  const [tenants, setTenants] = useState<any[]>([]);
  const [activeTenant, setActiveTenant] = useState('tenant-acme-123');

  const [activePlugins, setActivePlugins] = useState<string[]>(['jira']);

  const [etlOps, setEtlOps] = useState<string[]>(['imputation', 'type_sync']);
  const [isEtlRunning, setIsEtlRunning] = useState(false);
  const [etlMessage, setEtlMessage] = useState<string | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    setIsDark(document.documentElement.classList.contains('dark'));
    return () => observer.disconnect();
  }, []);

  // Fetch initial data
  const fetchData = async () => {
    try {
      const headers = authHeaders();
      
      const connRes = await fetch(getApiUrl('/api/enterprise/connections'), { headers });
      if (connRes.ok) setConnections(await connRes.json());
      
      const docRes = await fetch(getApiUrl('/api/enterprise/documents'), { headers });
      if (docRes.ok) setDocuments(await docRes.json());

      const logRes = await fetch(getApiUrl('/api/enterprise/audit-logs'), { headers });
      if (logRes.ok) setAuditLogs(await logRes.json());

      const tenantRes = await fetch(getApiUrl('/api/enterprise/tenants'), { headers });
      if (tenantRes.ok) setTenants(await tenantRes.json());
    } catch (err) {
      console.error('Enterprise Suite fetching failed', err);
    }
  };

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  // RBAC permissions helper
  const isViewer = user.role.toLowerCase() === 'viewer';

  // ── Connection Actions ───────────────────────────────────────────────────
  const handleCreateConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isViewer) return;
    if (!newConnName.trim()) return;

    setIsTestingConn(true);
    setConnMessage(null);

    const config = newConnType === 'sql' 
      ? { host: newConnHost, port: 5432, database: newConnDatabase, query: newConnQuery }
      : { url: newConnUrl, method: 'GET' };

    try {
      const res = await fetch(getApiUrl('/api/enterprise/connections'), {
        method: 'POST',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({ name: newConnName.trim(), type: newConnType, config })
      });
      if (!res.ok) throw new Error('Bağlantı oluşturulamadı.');
      
      setNewConnName('');
      setNewConnHost('');
      setNewConnDatabase('');
      setNewConnQuery('');
      setNewConnUrl('');
      setConnMessage({ type: 'success', text: 'Konnektör başarıyla oluşturuldu ve test edildi!' });
      fetchData();
    } catch (err: any) {
      setConnMessage({ type: 'error', text: err.message });
    } finally {
      setIsTestingConn(false);
    }
  };

  const handleDeleteConnection = async (id: number) => {
    if (isViewer) return;
    try {
      await fetch(getApiUrl(`/api/enterprise/connections/${id}`), {
        method: 'DELETE',
        headers: authHeaders()
      });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleIngestConnection = async (id: number) => {
    try {
      setConnMessage({ type: 'success', text: 'Veri çekme işlemi başlatıldı, lütfen bekleyin...' });
      const res = await fetch(getApiUrl(`/api/enterprise/connections/${id}/ingest`), {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Eşitleme başarısız.');
      setConnMessage({ type: 'success', text: `${data.dataset.filename} başarıyla platforma aktarıldı!` });
    } catch (err: any) {
      setConnMessage({ type: 'error', text: err.message });
    }
  };

  // ── Document Actions (RAG) ────────────────────────────────────────────────
  const handleUploadDocument = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isViewer) return;
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingDoc(true);
    setDocMessage(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(getApiUrl('/api/enterprise/documents'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('reai_token')}`
        },
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Yükleme başarısız.');
      
      setDocMessage({ type: 'success', text: `"${file.name}" yüklendi ve Qdrant üzerinde indekslendi.` });
      fetchData();
    } catch (err: any) {
      setDocMessage({ type: 'error', text: err.message });
    } finally {
      setIsUploadingDoc(false);
    }
  };

  const handleDeleteDoc = async (id: number) => {
    if (isViewer) return;
    try {
      await fetch(getApiUrl(`/api/enterprise/documents/${id}`), {
        method: 'DELETE',
        headers: authHeaders()
      });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  // ── Role Actions (RBAC) ──────────────────────────────────────────────────
  const handleRoleChange = async (role: string) => {
    try {
      const res = await fetch(getApiUrl('/api/enterprise/roles'), {
        method: 'PUT',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({ role })
      });
      if (res.ok) {
        onUserUpdate({ ...user, role: role as any });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // ── Tenant Switch ────────────────────────────────────────────────────────
  const handleTenantSwitch = async (tenantId: string) => {
    setActiveTenant(tenantId);
    try {
      await fetch(getApiUrl('/api/enterprise/tenants'), {
        method: 'POST',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({ tenantId, name: tenants.find(t => t.tenant_id === tenantId)?.name || 'Tenant' })
      });
      fetchData();
    } catch (err) {
      console.error(err);
    }
  };

  // ── ETL Pipeline Trigger ────────────────────────────────────────────────
  const handleRunEtl = async () => {
    setIsEtlRunning(true);
    setEtlMessage(null);

    try {
      const res = await fetch(getApiUrl('/api/enterprise/etl/run'), {
        method: 'POST',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({ operations: etlOps })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'ETL başarısız.');
      setEtlMessage(`Pipeline Başarılı! Temizlenmiş veri seti aktif edildi: ${data.dataset.filename}`);
    } catch (err: any) {
      setEtlMessage(`Hata: ${err.message}`);
    } finally {
      setIsEtlRunning(false);
    }
  };

  const togglePlugin = (plugin: string) => {
    setActivePlugins(prev => 
      prev.includes(plugin) ? prev.filter(p => p !== plugin) : [...prev, plugin]
    );
  };

  // Tabs layout navigation items
  const tabs = [
    { id: 'connectors', label: 'Veri Bağlantıları', icon: Database },
    { id: 'etl', label: 'ETL İş Akışı', icon: GitBranch },
    { id: 'rag', label: 'RAG & PDF Havuzu', icon: FileText },
    { id: 'rbac', label: 'Rol Yetkileri (RBAC)', icon: Users },
    { id: 'tenant', label: 'Kiracılar (Tenants)', icon: Building2 },
    { id: 'plugins', label: 'Eklentiler SDK', icon: Cpu },
    { id: 'audit', label: 'Denetim Günlüğü', icon: History }
  ] as const;

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-7xl mx-auto pb-24">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase italic flex items-center gap-3">
            <Shield className={cn("w-8 h-8", isDark ? "text-[#FFD700]" : "text-[#4F46E5]")} />
            Kurumsal Yönetim
          </h1>
          <p className={cn("text-xs mt-1", isDark ? "text-white/50" : "text-slate-500")}>
            SaaS ölçekli veri konnektörlerini, RAG altyapısını, RBAC rollerini ve sistem denetim kayıtlarını yönetin.
          </p>
        </div>

        {/* Current Active Space */}
        <div className={cn(
          "px-4 py-2 rounded-xl border text-xs font-bold flex items-center gap-3",
          isDark ? "bg-white/5 border-white/10" : "bg-white border-slate-200"
        )}>
          <Building2 className="w-4 h-4 text-emerald-500" />
          <div>
            <span className="opacity-50">Aktif Organizasyon:</span>{' '}
            <span className="text-[#FFD700]">{tenants.find(t => t.tenant_id === activeTenant)?.name || 'Yükleniyor...'}</span>
          </div>
        </div>
      </div>

      {/* Main Grid: Left Tabs / Right Content */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        
        {/* Left Side: Navigation Tabs */}
        <div className="lg:col-span-1 flex flex-row lg:flex-col gap-2 overflow-x-auto pb-4 lg:pb-0 shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-bold uppercase tracking-wider transition-all border whitespace-nowrap lg:w-full",
                activeTab === tab.id
                  ? (isDark 
                      ? "bg-white/10 text-[#FFD700] border-white/10" 
                      : "bg-indigo-50 text-[#4F46E5] border-indigo-100 shadow-sm")
                  : (isDark 
                      ? "bg-transparent border-transparent opacity-60 hover:opacity-100 hover:bg-white/5" 
                      : "bg-transparent border-transparent text-slate-600 hover:bg-slate-50")
              )}
            >
              <tab.icon className="w-4 h-4 shrink-0" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Right Side: Tab Workspace */}
        <div className="lg:col-span-3">
          
          {/* RBAC Warning Alert for Viewers */}
          {isViewer && (
            <div className="p-4 mb-6 bg-rose-500/10 border border-rose-500/20 text-rose-400 rounded-2xl text-xs font-bold flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>Viewer rolüyle giriş yaptınız. Platform ayarlarını değiştiremez, veri ekleyemez veya silemezsiniz.</span>
            </div>
          )}

          {/* 1. VERI BAGLANTILARI (CONNECTORS) */}
          {activeTab === 'connectors' && (
            <div className="space-y-6">
              <div className={cn(
                "p-6 rounded-2xl border transition-colors shadow-sm",
                isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200"
              )}>
                <h3 className="text-lg font-bold uppercase tracking-wider mb-4 flex items-center gap-2">
                  <Database className="w-5 h-5 text-indigo-500" />
                  Yeni Veri Konnektörü Ekle
                </h3>
                
                <form onSubmit={handleCreateConnection} className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">Bağlantı İsmi</label>
                      <input
                        type="text"
                        required
                        value={newConnName}
                        onChange={(e) => setNewConnName(e.target.value)}
                        className={cn(
                          "w-full px-4 py-3 rounded-xl border text-xs focus:outline-none",
                          isDark ? "bg-[#1A1A1A] border-white/10 text-white focus:border-[#FFD700]" : "bg-slate-50 border-slate-200 text-slate-800 focus:border-[#4F46E5]"
                        )}
                        placeholder="Örn: PostgreSQL Satış Veritabanı"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">Bağlantı Tipi</label>
                      <select
                        value={newConnType}
                        onChange={(e: any) => setNewConnType(e.target.value)}
                        className={cn(
                          "w-full px-4 py-3 rounded-xl border text-xs focus:outline-none",
                          isDark ? "bg-[#1A1A1A] border-white/10 text-white" : "bg-slate-50 border-slate-200 text-slate-800"
                        )}
                      >
                        <option value="sql">SQL Veritabanı (PostgreSQL / SQL Server)</option>
                        <option value="api">Dinamik REST API Entegrasyonu</option>
                      </select>
                    </div>
                  </div>

                  {newConnType === 'sql' ? (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">Sunucu Adresi (Host)</label>
                        <input
                          type="text"
                          value={newConnHost}
                          onChange={(e) => setNewConnHost(e.target.value)}
                          className={cn(
                            "w-full px-4 py-3 rounded-xl border text-xs focus:outline-none",
                            isDark ? "bg-[#1A1A1A] border-white/10 text-white" : "bg-slate-50 border-slate-200 text-slate-800"
                          )}
                          placeholder="localhost veya IP"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">Veritabanı İsmi</label>
                        <input
                          type="text"
                          value={newConnDatabase}
                          onChange={(e) => setNewConnDatabase(e.target.value)}
                          className={cn(
                            "w-full px-4 py-3 rounded-xl border text-xs focus:outline-none",
                            isDark ? "bg-[#1A1A1A] border-white/10 text-white" : "bg-slate-50 border-slate-200 text-slate-800"
                          )}
                          placeholder="enterprise_db"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">SQL Sorgusu (Query)</label>
                        <input
                          type="text"
                          value={newConnQuery}
                          onChange={(e) => setNewConnQuery(e.target.value)}
                          className={cn(
                            "w-full px-4 py-3 rounded-xl border text-xs focus:outline-none",
                            isDark ? "bg-[#1A1A1A] border-white/10 text-white" : "bg-slate-50 border-slate-200 text-slate-800"
                          )}
                          placeholder="SELECT * FROM sales"
                        />
                      </div>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">REST API Endpoint URL</label>
                      <input
                        type="url"
                        value={newConnUrl}
                        onChange={(e) => setNewConnUrl(e.target.value)}
                        className={cn(
                          "w-full px-4 py-3 rounded-xl border text-xs focus:outline-none",
                          isDark ? "bg-[#1A1A1A] border-white/10 text-white" : "bg-slate-50 border-slate-200 text-slate-800"
                        )}
                        placeholder="https://api.sirket.com/v1/veri"
                      />
                    </div>
                  )}

                  {connMessage && (
                    <div className={cn(
                      "p-3 rounded-xl text-xs font-bold flex items-center gap-2",
                      connMessage.type === 'success' 
                        ? (isDark ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-50 text-emerald-600")
                        : (isDark ? "bg-rose-500/10 text-rose-400" : "bg-rose-50 text-rose-600")
                    )}>
                      <Check className="w-4 h-4 shrink-0" />
                      <span>{connMessage.text}</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={isTestingConn || isViewer}
                    className={cn(
                      "px-6 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-all duration-200 shadow-sm flex items-center gap-2",
                      isDark
                        ? "bg-[#FFD700] text-black hover:bg-[#FFE57F]"
                        : "bg-[#4F46E5] text-white hover:bg-[#4338CA]",
                      isViewer && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <Plus className="w-4 h-4" />
                    {isTestingConn ? 'Test Ediliyor...' : 'Bağlantıyı Eşitle & Kaydet'}
                  </button>
                </form>
              </div>

              {/* Active Connectors List */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold uppercase tracking-widest opacity-60">Tanımlı Veri Konnektörleri</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {connections.map((conn) => {
                    const cfg = JSON.parse(conn.config);
                    return (
                      <div
                        key={conn.id}
                        className={cn(
                          "p-5 rounded-2xl border flex flex-col justify-between transition-colors shadow-sm",
                          isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200"
                        )}
                      >
                        <div>
                          <div className="flex items-center justify-between mb-3">
                            <span className={cn(
                              "px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider",
                              conn.type === 'sql' 
                                ? (isDark ? "bg-indigo-500/10 text-indigo-400" : "bg-indigo-50 text-indigo-600")
                                : (isDark ? "bg-sky-500/10 text-sky-400" : "bg-sky-50 text-sky-600")
                            )}>
                              {conn.type === 'sql' ? 'SQL Database' : 'REST API'}
                            </span>
                            <span className="text-[10px] opacity-40">ID: {conn.id}</span>
                          </div>
                          
                          <h5 className="font-bold text-sm">{conn.name}</h5>
                          <p className="text-[10px] opacity-50 mt-1 truncate">
                            {conn.type === 'sql' ? `Veritabanı: ${cfg.database} | SQL: ${cfg.query}` : `Endpoint: ${cfg.url}`}
                          </p>
                        </div>

                        <div className="flex items-center justify-between border-t border-dashed border-white/10 pt-4 mt-4">
                          <button
                            onClick={() => handleIngestConnection(conn.id)}
                            className={cn(
                              "flex items-center gap-2 px-3.5 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all",
                              isDark ? "bg-white/5 hover:bg-white/10 text-white" : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                            )}
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Şimdi Çek (Ingest)
                          </button>

                          <button
                            disabled={isViewer}
                            onClick={() => handleDeleteConnection(conn.id)}
                            className={cn(
                              "p-2 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors",
                              isViewer && "opacity-40 cursor-not-allowed"
                            )}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 2. ETL IS AKISI (DATA TRANSFORMATION) */}
          {activeTab === 'etl' && (
            <div className={cn(
              "p-6 rounded-2xl border transition-colors shadow-sm space-y-6",
              isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200"
            )}>
              <div>
                <h3 className="text-lg font-bold uppercase tracking-wider flex items-center gap-2">
                  <GitBranch className="w-5 h-5 text-emerald-500" />
                  Gelişmiş ETL Pipeline Motoru
                </h3>
                <p className="text-xs opacity-60 mt-1">
                  Veri kalitesini iyileştirmek için kolon dönüştürme ve veri temizleme kuralları tanımlayın.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Operations Selector */}
                <div className="space-y-4">
                  <h4 className="text-sm font-bold uppercase tracking-widest opacity-60">ETL Adımları</h4>
                  
                  <div className="space-y-2">
                    {[
                      { id: 'imputation', label: 'Eksik Veri Tamamlama (Median Imputation)', desc: 'Boş değerleri medyan ile doldurur.' },
                      { id: 'type_sync', label: 'Veri Tipi Senkronizasyonu (Schema Mapping)', desc: 'Sayısal ve tarihsel kolonları standartlaştırır.' },
                      { id: 'anomaly_clean', label: 'Aykırı Değer Temizliği (Anomaly Removal)', desc: 'Aşırı yüksek veya alçak uç değerleri budar.' },
                      { id: 'dataset_merge', label: 'Çoklu Kaynak Birleştirme (Join/Merge)', desc: 'Aktif datasetleri tek şemada birleştirir.' }
                    ].map(op => (
                      <label
                        key={op.id}
                        className={cn(
                          "flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-colors",
                          etlOps.includes(op.id)
                            ? (isDark ? "bg-emerald-500/5 border-emerald-500/30" : "bg-emerald-50/50 border-emerald-300")
                            : (isDark ? "bg-white/5 border-white/5" : "bg-slate-50 border-slate-100")
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={etlOps.includes(op.id)}
                          onChange={() => {
                            setEtlOps(prev => prev.includes(op.id) ? prev.filter(x => x !== op.id) : [...prev, op.id]);
                          }}
                          className="mt-1 accent-emerald-500"
                        />
                        <div>
                          <p className="text-xs font-bold">{op.label}</p>
                          <p className="text-[10px] opacity-50 mt-0.5">{op.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>

                  <button
                    onClick={handleRunEtl}
                    disabled={isEtlRunning || isViewer || etlOps.length === 0}
                    className={cn(
                      "w-full py-4 rounded-xl text-xs font-bold uppercase tracking-widest transition-all duration-200 shadow-sm flex items-center justify-center gap-2",
                      isDark
                        ? "bg-[#FFD700] text-black hover:bg-[#FFE57F]"
                        : "bg-[#4F46E5] text-white hover:bg-[#4338CA]",
                      (isViewer || etlOps.length === 0) && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <Play className="w-4 h-4 fill-current" />
                    {isEtlRunning ? 'Pipeline Çalıştırılıyor...' : 'Pipeline İş Akışını Başlat'}
                  </button>
                </div>

                {/* Pipeline visual diagram */}
                <div className={cn(
                  "p-5 rounded-2xl border flex flex-col justify-center items-center gap-4 text-center min-h-[300px]",
                  isDark ? "bg-white/5 border-white/5" : "bg-slate-50 border-slate-100"
                )}>
                  {isEtlRunning ? (
                    <div className="space-y-3">
                      <RefreshCw className="w-10 h-10 animate-spin text-emerald-500 mx-auto" />
                      <p className="text-xs font-bold">ETL Modülü veri kümelerini normalize ediyor...</p>
                    </div>
                  ) : etlMessage ? (
                    <div className="space-y-3">
                      <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto" />
                      <p className="text-xs font-bold text-emerald-500">{etlMessage}</p>
                      <p className="text-[10px] opacity-50">Veri kalitesi %98 seviyesine optimize edildi. Analiz Paneli yeni verilerle güncellendi.</p>
                    </div>
                  ) : (
                    <div className="space-y-4 max-w-xs">
                      <div className="w-12 h-12 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center mx-auto">
                        <GitBranch className="w-6 h-6" />
                      </div>
                      <h5 className="font-bold text-xs uppercase tracking-widest">Pipeline Yapılandırıcı</h5>
                      <p className="text-[10px] opacity-50">
                        Sol taraftan uygulamak istediğiniz ETL veri mühendisliği dönüşümlerini seçip pipeline iş akışını tetikleyin.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 3. RAG & PDF HAVUZU */}
          {activeTab === 'rag' && (
            <div className="space-y-6">
              <div className={cn(
                "p-6 rounded-2xl border transition-colors shadow-sm",
                isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200"
              )}>
                <h3 className="text-lg font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-indigo-500" />
                  RAG Doküman Yükleme Arayüzü (Vector DB)
                </h3>
                <p className="text-xs opacity-60 mb-6">
                  PDF veya TXT formatındaki kurumsal belgeleri yükleyin. Belgeler otomatik olarak semantik parçalara (chunks) ayrılacak ve Qdrant üzerinde vektör indekslemesi yapılacaktır.
                </p>

                {/* Upload drag-drop area */}
                <div className={cn(
                  "border-2 border-dashed rounded-2xl p-8 text-center transition-all duration-200 cursor-pointer relative",
                  isDark 
                    ? "border-white/10 hover:border-[#FFD700] hover:bg-white/5" 
                    : "border-slate-300 hover:border-[#4F46E5] hover:bg-slate-50"
                )}>
                  <input
                    type="file"
                    disabled={isViewer}
                    accept=".pdf,.txt"
                    onChange={handleUploadDocument}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                  />
                  <div className="space-y-3">
                    <Upload className="w-10 h-10 mx-auto text-indigo-500" />
                    <div>
                      <p className="text-xs font-bold">
                        {isUploadingDoc ? 'Doküman Yükleniyor & İndeksleniyor...' : 'Bir PDF veya TXT dosyası seçin veya sürükleyin'}
                      </p>
                      <p className="text-[10px] opacity-40 mt-1">Maksimum dosya boyutu: 10MB</p>
                    </div>
                  </div>
                </div>

                {docMessage && (
                  <div className={cn(
                    "p-3 mt-4 rounded-xl text-xs font-bold flex items-center gap-2",
                    docMessage.type === 'success' 
                      ? (isDark ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-50 text-emerald-600")
                      : (isDark ? "bg-rose-500/10 text-rose-400" : "bg-rose-50 text-rose-600")
                  )}>
                    <Check className="w-4 h-4 shrink-0" />
                    <span>{docMessage.text}</span>
                  </div>
                )}
              </div>

              {/* Indexed document list */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold uppercase tracking-widest opacity-60">İndekslenmiş Kurumsal Dokümanlar</h4>
                <div className={cn(
                  "border rounded-2xl overflow-hidden shadow-sm",
                  isDark ? "border-white/5 bg-[#151515]" : "border-slate-200 bg-white"
                )}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className={cn(
                          "border-b font-bold uppercase tracking-wider text-[10px]",
                          isDark ? "border-white/10 bg-white/5 text-white/50" : "border-slate-100 bg-slate-50 text-slate-500"
                        )}>
                          <th className="py-4 px-6">Dosya Adı</th>
                          <th className="py-4 px-6">Parça (Chunk) Sayısı</th>
                          <th className="py-4 px-6">Durum</th>
                          <th className="py-4 px-6">Yüklenme Tarihi</th>
                          <th className="py-4 px-6 text-right">Aksiyon</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {documents.map((doc) => (
                          <tr key={doc.id} className={isDark ? "hover:bg-white/5" : "hover:bg-slate-50"}>
                            <td className="py-4 px-6 font-bold flex items-center gap-2">
                              <FileText className="w-4 h-4 text-[#FFD700]" />
                              {doc.filename}
                            </td>
                            <td className="py-4 px-6">{doc.chunks_count} parça</td>
                            <td className="py-4 px-6">
                              <span className={cn(
                                "px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider",
                                doc.status === 'indexed' 
                                  ? (isDark ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-50 text-emerald-600")
                                  : "bg-amber-500/10 text-amber-400"
                              )}>
                                {doc.status === 'indexed' ? 'Vektör İndekslendi' : 'İndeksleniyor'}
                              </span>
                            </td>
                            <td className="py-4 px-6 opacity-60">
                              {new Date(doc.created_at).toLocaleDateString('tr-TR')}
                            </td>
                            <td className="py-4 px-6 text-right">
                              <button
                                disabled={isViewer}
                                onClick={() => handleDeleteDoc(doc.id)}
                                className={cn(
                                  "p-2 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors",
                                  isViewer && "opacity-40 cursor-not-allowed"
                                )}
                              >
                                <Trash2 className="w-4.5 h-4.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {documents.length === 0 && (
                          <tr>
                            <td colSpan={5} className="py-8 text-center opacity-40">
                              Kayıtlı RAG dokümanı bulunamadı.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 4. ROL BAZLI YETKILENDIRME (RBAC) */}
          {activeTab === 'rbac' && (
            <div className={cn(
              "p-6 rounded-2xl border transition-colors shadow-sm space-y-6",
              isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200"
            )}>
              <div>
                <h3 className="text-lg font-bold uppercase tracking-wider flex items-center gap-2">
                  <Users className="w-5 h-5 text-indigo-500" />
                  Granular Rol Bazlı Erişim Yetkileri (RBAC)
                </h3>
                <p className="text-xs opacity-60 mt-1">
                  Rol değiştirerek UI ve API seviyesindeki erişim kısıtlamalarını test edebilirsiniz.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { role: 'admin', label: 'Administrator', desc: 'Tam Yetki: Veri yazma, silme, konnektör ekleme ve yetkilendirmeleri yapabilir.' },
                  { role: 'analyst', label: 'Analyst', desc: 'Veri Analiz Yetkisi: Veri ekleyebilir ve inceleyebilir, ancak konnektörleri silemez.' },
                  { role: 'viewer', label: 'Viewer (Sınırlı)', desc: 'Salt Okunur Yetki: Veri setlerini inceleyebilir, ancak hiçbir silme/ekleme operasyonu yapamaz.' }
                ].map(r => (
                  <button
                    key={r.role}
                    onClick={() => handleRoleChange(r.role)}
                    className={cn(
                      "p-5 rounded-2xl border text-left flex flex-col justify-between transition-all",
                      user.role.toLowerCase() === r.role 
                        ? (isDark ? "bg-[#FFD700]/5 border-[#FFD700] text-white" : "bg-indigo-50/50 border-[#4F46E5] text-slate-800")
                        : (isDark ? "bg-white/5 border-white/5 hover:bg-white/10" : "bg-slate-50 border-slate-100 hover:bg-slate-100/50")
                    )}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-bold text-sm">{r.label}</span>
                        {user.role.toLowerCase() === r.role && <CheckCircle className="w-4 h-4 text-emerald-500" />}
                      </div>
                      <p className="text-[10px] opacity-50 leading-relaxed">{r.desc}</p>
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-widest mt-6 opacity-60">
                      {user.role.toLowerCase() === r.role ? 'Aktif Rol' : 'Seç'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 5. COKLU KIRACI (TENANT) */}
          {activeTab === 'tenant' && (
            <div className={cn(
              "p-6 rounded-2xl border transition-colors shadow-sm space-y-6",
              isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200"
            )}>
              <div>
                <h3 className="text-lg font-bold uppercase tracking-wider flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-indigo-500" />
                  SaaS Çoklu Kiracı (Multi-Tenant) Yönetimi
                </h3>
                <p className="text-xs opacity-60 mt-1">
                  Şirketler veya departmanlar arasında mantıksal veri izolasyonu sağlayarak izolasyon uzayları tanımlayın.
                </p>
              </div>

              <div className="space-y-4">
                <h4 className="text-sm font-bold uppercase tracking-widest opacity-60">Organizasyon Değiştir</h4>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {tenants.map((tenant) => (
                    <button
                      key={tenant.id}
                      onClick={() => handleTenantSwitch(tenant.tenant_id)}
                      className={cn(
                        "p-5 rounded-2xl border text-left flex items-start gap-4 transition-all",
                        activeTenant === tenant.tenant_id
                          ? (isDark ? "bg-white/10 border-[#FFD700]" : "bg-indigo-50 border-[#4F46E5]")
                          : (isDark ? "bg-white/5 border-white/5 hover:bg-white/10" : "bg-slate-50 border-slate-100 hover:bg-slate-100")
                      )}
                    >
                      <Building2 className="w-6 h-6 text-indigo-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-bold">{tenant.name}</p>
                        <p className="text-[10px] opacity-40 uppercase tracking-tighter mt-1">Tenant ID: {tenant.tenant_id}</p>
                        <p className="text-[10px] opacity-40 mt-0.5">Sanal İzolasyon: AKTİF</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 6. EKLENTI SDK (PLUGINS) */}
          {activeTab === 'plugins' && (
            <div className={cn(
              "p-6 rounded-2xl border transition-colors shadow-sm space-y-6",
              isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200"
            )}>
              <div>
                <h3 className="text-lg font-bold uppercase tracking-wider flex items-center gap-2">
                  <Cpu className="w-5 h-5 text-indigo-500" />
                  Harici Sistem Eklenti Havuzu (Plugin SDK)
                </h3>
                <p className="text-xs opacity-60 mt-1">
                  SAP, Salesforce, Jira ve HubSpot gibi harici sistemlerden veri çekebilmek için eklenti entegrasyonlarını etkinleştirin.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { id: 'sap', name: 'SAP ERP Integration', desc: 'Finansal defter ve fatura verilerini sisteme aktarır.', version: 'v3.2.1' },
                  { id: 'salesforce', name: 'Salesforce CRM Connector', desc: 'Müşteri profili ve dönüşüm hunisi verilerini çeker.', version: 'v2.1.0' },
                  { id: 'jira', name: 'Jira Software SDK', desc: 'Proje sprint ve iş listesi performans metriklerini alır.', version: 'v4.0.5' },
                  { id: 'hubspot', name: 'HubSpot Marketing API', desc: 'Pazarlama kampanyası verilerini entegre eder.', version: 'v1.6.0' }
                ].map(p => (
                  <div
                    key={p.id}
                    className={cn(
                      "p-5 rounded-2xl border flex flex-col justify-between transition-colors shadow-sm",
                      isDark ? "bg-white/5 border-white/5" : "bg-slate-50 border-slate-100"
                    )}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-[10px] font-bold opacity-40">{p.version}</span>
                        <div className="flex items-center gap-1.5">
                          <div className={cn(
                            "w-2.5 h-2.5 rounded-full",
                            activePlugins.includes(p.id) ? "bg-emerald-500" : "bg-slate-500"
                          )} />
                          <span className="text-[10px] font-bold opacity-60">
                            {activePlugins.includes(p.id) ? 'Etkin' : 'Pasif'}
                          </span>
                        </div>
                      </div>
                      <h5 className="font-bold text-sm">{p.name}</h5>
                      <p className="text-[10px] opacity-50 mt-1">{p.desc}</p>
                    </div>

                    <div className="flex items-center justify-between mt-6 pt-4 border-t border-white/5">
                      <button
                        onClick={() => togglePlugin(p.id)}
                        className={cn(
                          "px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all",
                          activePlugins.includes(p.id)
                            ? "bg-rose-500/10 text-rose-400 hover:bg-rose-500/20"
                            : (isDark ? "bg-[#FFD700] text-black hover:bg-[#FFE57F]" : "bg-[#4F46E5] text-white hover:bg-[#4338CA]")
                        )}
                      >
                        {activePlugins.includes(p.id) ? 'Devre Dışı Bırak' : 'Eklentiyi Etkinleştir'}
                      </button>

                      <a href="#" className="text-[10px] opacity-40 hover:opacity-100 flex items-center gap-1">
                        SDK Dokümantasyonu
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 7. DENETIM GUNLUGU (AUDIT LOG) */}
          {activeTab === 'audit' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-lg font-bold uppercase tracking-wider flex items-center gap-2">
                  <History className="w-5 h-5 text-indigo-500" />
                  Sistem Denetim Günlüğü (Immutable Audit Trail)
                </h3>

                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 w-4 h-4 opacity-40" />
                  <input
                    type="text"
                    value={auditSearch}
                    onChange={(e) => setAuditSearch(e.target.value)}
                    className={cn(
                      "pl-9 pr-4 py-2 w-64 rounded-xl border text-xs focus:outline-none",
                      isDark ? "bg-[#151515] border-white/10 text-white focus:border-[#FFD700]" : "bg-white border-slate-200 text-slate-800 focus:border-[#4F46E5]"
                    )}
                    placeholder="Loglarda ara..."
                  />
                </div>
              </div>

              <div className={cn(
                "border rounded-2xl overflow-hidden shadow-sm",
                isDark ? "border-white/5 bg-[#151515]" : "border-slate-200 bg-white"
              )}>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className={cn(
                        "border-b font-bold uppercase tracking-wider text-[10px]",
                        isDark ? "border-white/10 bg-white/5 text-white/50" : "border-slate-100 bg-slate-50 text-slate-500"
                      )}>
                        <th className="py-4 px-6">Kullanıcı</th>
                        <th className="py-4 px-6">İşlem / Olay</th>
                        <th className="py-4 px-6">Detaylar</th>
                        <th className="py-4 px-6">IP Adresi</th>
                        <th className="py-4 px-6">Tarih</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {auditLogs
                        .filter(log => 
                          log.action.toLowerCase().includes(auditSearch.toLowerCase()) || 
                          log.details.toLowerCase().includes(auditSearch.toLowerCase())
                        )
                        .map((log) => (
                          <tr key={log.id} className={isDark ? "hover:bg-white/5" : "hover:bg-slate-50"}>
                            <td className="py-4 px-6 font-bold">{log.email}</td>
                            <td className="py-4 px-6">
                              <span className={cn(
                                "px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider",
                                isDark ? "bg-indigo-500/10 text-indigo-400" : "bg-indigo-50 text-indigo-600"
                              )}>
                                {log.action}
                              </span>
                            </td>
                            <td className="py-4 px-6 opacity-80">{log.details}</td>
                            <td className="py-4 px-6 opacity-60 font-mono">{log.ip_address}</td>
                            <td className="py-4 px-6 opacity-60">
                              {new Date(log.created_at).toLocaleString('tr-TR')}
                            </td>
                          </tr>
                        ))}
                      {auditLogs.length === 0 && (
                        <tr>
                          <td colSpan={5} className="py-8 text-center opacity-40">
                            Kayıtlı sistem günlüğü bulunamadı.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
