import React, { useState, useEffect, useCallback } from 'react';
import {
  Database,
  GitBranch,
  FileText,
  Users,
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
  Clock,
  ChevronDown,
  ChevronUp,
  Bell,
  Send
} from 'lucide-react';
import { cn } from '../lib/utils';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import { User } from '../types';

interface EnterpriseSuiteProps {
  user: User;
  onUserUpdate: (updatedUser: User) => void;
}

interface EnterpriseConnection {
  id: number;
  type: string;
  name: string;
  config: string | Record<string, unknown>;
  encryptionStatus: string;
  schedule_enabled: number;
  schedule_interval_minutes: number;
  next_sync_at: string | null;
  last_synced_at: string | null;
  last_sync_status: 'success' | 'failure' | null;
  last_sync_error: string | null;
}

interface ConnectorSyncRun {
  id: string;
  status: 'success' | 'failure';
  row_count: number;
  column_count: number;
  error_message: string | null;
  started_at: string;
  finished_at: string;
}

type BusinessAlertEvent = 'kpi_breach' | 'kpi_recovery' | 'connector_failure' | 'connector_recovery' | 'billing';
interface NotificationSettings {
  emailEnabled: boolean;
  slackConfigured: boolean;
  teamsConfigured: boolean;
  events: BusinessAlertEvent[];
}

const parseConnectionConfig = (config: unknown): Record<string, unknown> => {
  if (config && typeof config === 'object') return config as Record<string, unknown>;
  if (typeof config !== 'string') return {};
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const apiErrorMessage = async (response: Response, fallback: string) => {
  try {
    const data = await response.json();
    return data.error?.message || fallback;
  } catch {
    return fallback;
  }
};

export default function EnterpriseSuite({ user }: EnterpriseSuiteProps) {
  const [activeTab, setActiveTab] = useState<'connectors' | 'etl' | 'rag' | 'rbac' | 'notifications' | 'governance' | 'audit'>('connectors');
  const [isDark, setIsDark] = useState(true);
  const [loadError, setLoadError] = useState('');

  // States for various tabs
  const [connections, setConnections] = useState<EnterpriseConnection[]>([]);
  const [scheduleDrafts, setScheduleDrafts] = useState<Record<number, number>>({});
  const [busyConnectionId, setBusyConnectionId] = useState<number | null>(null);
  const [expandedConnectionId, setExpandedConnectionId] = useState<number | null>(null);
  const [syncRuns, setSyncRuns] = useState<Record<number, ConnectorSyncRun[]>>({});
  const [newConnName, setNewConnName] = useState('');
  const [newConnType, setNewConnType] = useState<'api' | 'postgresql'>('api');
  const [newConnUrl, setNewConnUrl] = useState('');
  const [newSqlConfig, setNewSqlConfig] = useState({
    host: '', port: '5432', database: '', username: '', password: '',
    query: 'SELECT * FROM public.sales', sslMode: 'require' as 'require' | 'verify-full'
  });
  const [isTestingConn, setIsTestingConn] = useState(false);
  const [connMessage, setConnMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const [documents, setDocuments] = useState<any[]>([]);
  const [isUploadingDoc, setIsUploadingDoc] = useState(false);
  const [docMessage, setDocMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditSearch, setAuditSearch] = useState('');

  const [etlOps, setEtlOps] = useState<string[]>(['imputation', 'type_sync']);
  const [isEtlRunning, setIsEtlRunning] = useState(false);
  const [etlMessage, setEtlMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>({
    emailEnabled: false,
    slackConfigured: false,
    teamsConfigured: false,
    events: ['kpi_breach', 'kpi_recovery', 'connector_failure', 'connector_recovery', 'billing']
  });
  const [slackWebhook, setSlackWebhook] = useState('');
  const [teamsWebhook, setTeamsWebhook] = useState('');
  const [removeSlack, setRemoveSlack] = useState(false);
  const [removeTeams, setRemoveTeams] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [retentionPolicy, setRetentionPolicy] = useState({ enabled: false, retentionDays: 365, lastAppliedAt: null as string | null });
  const [governanceBusy, setGovernanceBusy] = useState(false);
  const [governanceMessage, setGovernanceMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    setIsDark(document.documentElement.classList.contains('dark'));
    return () => observer.disconnect();
  }, []);

  // Fetch initial data
  const fetchData = useCallback(async () => {
    setLoadError('');
    try {
      const headers = authHeaders();
      if (activeTab === 'connectors') {
        const response = await fetch(getApiUrl('/api/enterprise/connections'), { headers });
        if (!response.ok) throw new Error(await apiErrorMessage(response, 'REST API bağlantıları yüklenemedi.'));
        const items = await response.json() as EnterpriseConnection[];
        setConnections(items);
        setScheduleDrafts((current) => Object.fromEntries(items.map((item) => [
          item.id,
          current[item.id] || item.schedule_interval_minutes || 60
        ])));
      } else if (activeTab === 'rag') {
        const response = await fetch(getApiUrl('/api/enterprise/documents'), { headers });
        if (!response.ok) throw new Error(await apiErrorMessage(response, 'Dokümanlar yüklenemedi.'));
        setDocuments(await response.json());
      } else if (activeTab === 'audit') {
        const response = await fetch(getApiUrl('/api/enterprise/audit-logs'), { headers });
        if (!response.ok) throw new Error(await apiErrorMessage(response, 'Denetim kayıtları yüklenemedi.'));
        setAuditLogs(await response.json());
      } else if (activeTab === 'notifications') {
        const response = await fetch(getApiUrl('/api/enterprise/notification-settings'), { headers });
        if (!response.ok) throw new Error(await apiErrorMessage(response, 'Bildirim ayarları yüklenemedi.'));
        setNotificationSettings(await response.json());
      } else if (activeTab === 'governance') {
        const response = await fetch(getApiUrl('/api/enterprise/data-governance'), { headers });
        if (!response.ok) throw new Error(await apiErrorMessage(response, 'Veri yönetişimi ayarları yüklenemedi.'));
        setRetentionPolicy(await response.json());
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Kurumsal veriler yüklenemedi.');
    }
  }, [activeTab]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // RBAC permissions helper
  const isViewer = user.role.toLowerCase() === 'viewer';
  const isAdmin = user.role.toLowerCase() === 'admin';

  // ── Connection Actions ───────────────────────────────────────────────────
  const handleCreateConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (isViewer) return;
    if (!newConnName.trim()) return;

    setIsTestingConn(true);
    setConnMessage(null);

    let config: Record<string, unknown>;
    if (newConnType === 'api') {
      let normalizedUrl: string;
      try {
        normalizedUrl = new URL(newConnUrl).toString();
      } catch {
        setConnMessage({ type: 'error', text: 'Geçerli bir HTTPS REST API adresi girin.' });
        setIsTestingConn(false);
        return;
      }
      if (!normalizedUrl.startsWith('https://')) {
        setConnMessage({ type: 'error', text: 'REST API bağlantısı HTTPS kullanmalıdır.' });
        setIsTestingConn(false);
        return;
      }
      config = { url: normalizedUrl, method: 'GET' };
    } else {
      config = { ...newSqlConfig, port: Number(newSqlConfig.port) };
    }

    try {
      const res = await fetch(getApiUrl('/api/enterprise/connections'), {
        method: 'POST',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({ name: newConnName.trim(), type: newConnType, config })
      });
      if (!res.ok) throw new Error(await apiErrorMessage(res, 'Bağlantı oluşturulamadı.'));
      
      setNewConnName('');
      setNewConnUrl('');
      setNewSqlConfig((current) => ({ ...current, host: '', database: '', username: '', password: '' }));
      setConnMessage({ type: 'success', text: `${newConnType === 'postgresql' ? 'PostgreSQL' : 'REST API'} bağlantısı başarıyla kaydedildi.` });
      await fetchData();
    } catch (err: any) {
      setConnMessage({ type: 'error', text: err.message });
    } finally {
      setIsTestingConn(false);
    }
  };

  const handleDeleteConnection = async (id: number) => {
    if (!isAdmin) return;
    if (isViewer) return;
    try {
      const response = await fetch(getApiUrl(`/api/enterprise/connections/${id}`), {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Bağlantı silinemedi.'));
      setConnMessage({ type: 'success', text: 'Veri bağlantısı silindi.' });
      await fetchData();
    } catch (err) {
      setConnMessage({ type: 'error', text: err instanceof Error ? err.message : 'Bağlantı silinemedi.' });
    }
  };

  const loadSyncHistory = async (connectionId: number) => {
    const response = await fetch(getApiUrl(`/api/enterprise/connections/${connectionId}/sync-runs?limit=10`), { headers: authHeaders() });
    if (!response.ok) throw new Error(await apiErrorMessage(response, 'Eşitleme geçmişi yüklenemedi.'));
    const payload = await response.json() as { items: ConnectorSyncRun[] };
    setSyncRuns((current) => ({ ...current, [connectionId]: payload.items }));
  };

  const handleIngestConnection = async (id: number) => {
    if (isViewer) return;
    const shouldRefreshHistory = expandedConnectionId === id || Object.prototype.hasOwnProperty.call(syncRuns, id);
    setBusyConnectionId(id);
    try {
      setConnMessage({ type: 'success', text: 'Veri çekme işlemi başlatıldı, lütfen bekleyin...' });
      const res = await fetch(getApiUrl(`/api/enterprise/connections/${id}/ingest`), {
        method: 'POST',
        headers: authHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Eşitleme başarısız.');
      await fetchData();
      if (shouldRefreshHistory) {
        try {
          await loadSyncHistory(id);
        } catch (historyError) {
          setConnMessage({
            type: 'error',
            text: `${data.dataset.filename} aktarıldı ancak eşitleme geçmişi yenilenemedi: ${historyError instanceof Error ? historyError.message : 'Bilinmeyen hata.'}`
          });
          return;
        }
      }
      setConnMessage({ type: 'success', text: `${data.dataset.filename} başarıyla platforma aktarıldı.` });
    } catch (err: any) {
      setConnMessage({ type: 'error', text: err.message });
    } finally {
      setBusyConnectionId(null);
    }
  };

  const handleScheduleConnection = async (connection: EnterpriseConnection) => {
    if (!isAdmin) return;
    setBusyConnectionId(connection.id);
    setConnMessage(null);
    try {
      const intervalMinutes = scheduleDrafts[connection.id] || connection.schedule_interval_minutes || 60;
      const response = await fetch(getApiUrl(`/api/enterprise/connections/${connection.id}/schedule`), {
        method: 'PATCH',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({ enabled: !Boolean(connection.schedule_enabled), intervalMinutes })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Otomatik yenileme ayarlanamadı.'));
      setConnMessage({
        type: 'success',
        text: connection.schedule_enabled ? 'Otomatik yenileme kapatıldı.' : `Otomatik yenileme ${intervalMinutes} dakikada bir çalışacak.`
      });
      await fetchData();
    } catch (error) {
      setConnMessage({ type: 'error', text: error instanceof Error ? error.message : 'Otomatik yenileme ayarlanamadı.' });
    } finally {
      setBusyConnectionId(null);
    }
  };

  const toggleSyncHistory = async (connectionId: number) => {
    if (expandedConnectionId === connectionId) {
      setExpandedConnectionId(null);
      return;
    }
    setExpandedConnectionId(connectionId);
    try {
      await loadSyncHistory(connectionId);
    } catch (error) {
      setConnMessage({ type: 'error', text: error instanceof Error ? error.message : 'Eşitleme geçmişi yüklenemedi.' });
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
        headers: authHeaders(),
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Yükleme başarısız.');
      
      setDocMessage({ type: 'success', text: `"${file.name}" başarıyla işlendi ve doküman havuzuna eklendi.` });
      await fetchData();
    } catch (err: any) {
      setDocMessage({ type: 'error', text: err.message });
    } finally {
      setIsUploadingDoc(false);
      e.currentTarget.value = '';
    }
  };

  const handleDeleteDoc = async (id: number) => {
    if (!isAdmin) return;
    if (isViewer) return;
    try {
      const response = await fetch(getApiUrl(`/api/enterprise/documents/${id}`), {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Doküman silinemedi.'));
      setDocMessage({ type: 'success', text: 'Doküman havuzdan kaldırıldı.' });
      await fetchData();
    } catch (err) {
      setDocMessage({ type: 'error', text: err instanceof Error ? err.message : 'Doküman silinemedi.' });
    }
  };

  // ── ETL Pipeline Trigger ────────────────────────────────────────────────
  const handleRunEtl = async () => {
    if (isViewer) return;
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
      setEtlMessage({ type: 'success', text: `Pipeline tamamlandı. İşlenen veri seti: ${data.dataset.filename}` });
    } catch (err: any) {
      setEtlMessage({ type: 'error', text: err.message || 'ETL işlemi tamamlanamadı.' });
    } finally {
      setIsEtlRunning(false);
    }
  };

  const toggleNotificationEvent = (event: BusinessAlertEvent) => {
    setNotificationSettings((current) => ({
      ...current,
      events: current.events.includes(event) ? current.events.filter((item) => item !== event) : [...current.events, event]
    }));
  };

  const saveNotifications = async () => {
    if (!isAdmin) return;
    setNotificationBusy(true);
    setNotificationMessage(null);
    try {
      const response = await fetch(getApiUrl('/api/enterprise/notification-settings'), {
        method: 'PUT',
        headers: { ...jsonHeaders(), ...authHeaders() },
        body: JSON.stringify({
          emailEnabled: notificationSettings.emailEnabled,
          events: notificationSettings.events,
          slackWebhook: slackWebhook.trim() || undefined,
          teamsWebhook: teamsWebhook.trim() || undefined,
          removeSlack,
          removeTeams
        })
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Bildirim ayarları kaydedilemedi.'));
      setNotificationSettings(await response.json());
      setSlackWebhook('');
      setTeamsWebhook('');
      setRemoveSlack(false);
      setRemoveTeams(false);
      setNotificationMessage({ type: 'success', text: 'Bildirim kanalları güvenli biçimde kaydedildi.' });
    } catch (error) {
      setNotificationMessage({ type: 'error', text: error instanceof Error ? error.message : 'Bildirim ayarları kaydedilemedi.' });
    } finally {
      setNotificationBusy(false);
    }
  };

  const testNotifications = async () => {
    setNotificationBusy(true);
    setNotificationMessage(null);
    try {
      const response = await fetch(getApiUrl('/api/enterprise/notification-settings/test'), { method: 'POST', headers: authHeaders() });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Test bildirimi gönderilemedi.'));
      setNotificationMessage({ type: 'success', text: 'Test bildirimi etkin kanallara gönderildi.' });
    } catch (error) {
      setNotificationMessage({ type: 'error', text: error instanceof Error ? error.message : 'Test bildirimi gönderilemedi.' });
    } finally {
      setNotificationBusy(false);
    }
  };

  const saveRetentionPolicy = async () => {
    setGovernanceBusy(true);
    setGovernanceMessage(null);
    try {
      const response = await fetch(getApiUrl('/api/enterprise/data-governance'), {
        method: 'PUT', headers: { ...jsonHeaders(), ...authHeaders() }, body: JSON.stringify(retentionPolicy)
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Saklama politikası kaydedilemedi.'));
      setRetentionPolicy(await response.json());
      setGovernanceMessage({ type: 'success', text: 'Veri saklama politikası kaydedildi.' });
    } catch (error) {
      setGovernanceMessage({ type: 'error', text: error instanceof Error ? error.message : 'Saklama politikası kaydedilemedi.' });
    } finally { setGovernanceBusy(false); }
  };

  const applyRetentionNow = async () => {
    if (!window.confirm('Süresi dolmuş geçmiş kayıtları şimdi kalıcı olarak silmek istiyor musunuz?')) return;
    setGovernanceBusy(true);
    setGovernanceMessage(null);
    try {
      const response = await fetch(getApiUrl('/api/enterprise/data-governance/apply'), { method: 'POST', headers: authHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || 'Saklama politikası uygulanamadı.');
      const total = Object.values(payload.deleted || {}).reduce((sum: number, value) => sum + Number(value || 0), 0);
      setGovernanceMessage({ type: 'success', text: `${total} süresi dolmuş geçmiş kaydı silindi.` });
      await fetchData();
    } catch (error) {
      setGovernanceMessage({ type: 'error', text: error instanceof Error ? error.message : 'Saklama politikası uygulanamadı.' });
    } finally { setGovernanceBusy(false); }
  };

  const exportOrganizationData = async () => {
    setGovernanceBusy(true);
    setGovernanceMessage(null);
    try {
      const response = await fetch(getApiUrl('/api/enterprise/data-governance/export'), { headers: authHeaders() });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'Kurum verisi dışa aktarılamadı.'));
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'reai-kurum-verisi.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setGovernanceMessage({ type: 'success', text: 'Kurum verisi güvenli JSON paketi olarak indirildi.' });
    } catch (error) {
      setGovernanceMessage({ type: 'error', text: error instanceof Error ? error.message : 'Kurum verisi dışa aktarılamadı.' });
    } finally { setGovernanceBusy(false); }
  };

  // Tabs layout navigation items
  const tabs = [
    { id: 'connectors', label: 'Veri Bağlantıları', icon: Database },
    { id: 'etl', label: 'ETL İş Akışı', icon: GitBranch },
    { id: 'rag', label: 'RAG & PDF Havuzu', icon: FileText },
    { id: 'rbac', label: 'Rol ve Yetkiler', icon: Users },
    { id: 'notifications', label: 'Bildirim Kanalları', icon: Bell },
    { id: 'governance', label: 'Veri Yönetişimi', icon: Shield },
    { id: 'audit', label: 'Denetim Günlüğü', icon: History }
  ] as const;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 pb-6 md:p-8">
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
                  <div className="flex gap-2" role="group" aria-label="Konnektör tipi">
                    {(['api', 'postgresql'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setNewConnType(type)}
                        className={cn(
                          "rounded-lg px-4 py-2 text-[10px] font-black uppercase tracking-wider",
                          newConnType === type
                            ? (isDark ? "bg-[#FFD700] text-black" : "bg-indigo-600 text-white")
                            : (isDark ? "bg-white/5 text-white/60" : "bg-slate-100 text-slate-500")
                        )}
                      >
                        {type === 'api' ? 'REST API' : 'PostgreSQL'}
                      </button>
                    ))}
                  </div>
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
                        placeholder="Örn: Satış REST API"
                      />
                    </div>
                    {newConnType === 'api' && <div>
                      <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">HTTPS REST API Endpoint</label>
                      <input
                        type="url"
                        required
                        value={newConnUrl}
                        onChange={(e) => setNewConnUrl(e.target.value)}
                        className={cn(
                          "w-full px-4 py-3 rounded-xl border text-xs focus:outline-none",
                          isDark ? "bg-[#1A1A1A] border-white/10 text-white" : "bg-slate-50 border-slate-200 text-slate-800"
                        )}
                        placeholder="https://api.sirket.com/v1/veri"
                      />
                    </div>}
                  </div>

                  {newConnType === 'postgresql' && (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <input required value={newSqlConfig.host} onChange={(event) => setNewSqlConfig((current) => ({ ...current, host: event.target.value }))} className={cn("rounded-xl border px-4 py-3 text-xs", isDark ? "border-white/10 bg-[#1A1A1A] text-white" : "border-slate-200 bg-slate-50")} placeholder="Veritabanı hostu" />
                      <input required inputMode="numeric" value={newSqlConfig.port} onChange={(event) => setNewSqlConfig((current) => ({ ...current, port: event.target.value }))} className={cn("rounded-xl border px-4 py-3 text-xs", isDark ? "border-white/10 bg-[#1A1A1A] text-white" : "border-slate-200 bg-slate-50")} placeholder="5432" />
                      <input required value={newSqlConfig.database} onChange={(event) => setNewSqlConfig((current) => ({ ...current, database: event.target.value }))} className={cn("rounded-xl border px-4 py-3 text-xs", isDark ? "border-white/10 bg-[#1A1A1A] text-white" : "border-slate-200 bg-slate-50")} placeholder="Veritabanı adı" />
                      <input required value={newSqlConfig.username} onChange={(event) => setNewSqlConfig((current) => ({ ...current, username: event.target.value }))} className={cn("rounded-xl border px-4 py-3 text-xs", isDark ? "border-white/10 bg-[#1A1A1A] text-white" : "border-slate-200 bg-slate-50")} placeholder="Salt-okunur kullanıcı" />
                      <input required type="password" autoComplete="new-password" value={newSqlConfig.password} onChange={(event) => setNewSqlConfig((current) => ({ ...current, password: event.target.value }))} className={cn("rounded-xl border px-4 py-3 text-xs", isDark ? "border-white/10 bg-[#1A1A1A] text-white" : "border-slate-200 bg-slate-50")} placeholder="Parola" />
                      <select value={newSqlConfig.sslMode} onChange={(event) => setNewSqlConfig((current) => ({ ...current, sslMode: event.target.value as 'require' | 'verify-full' }))} className={cn("rounded-xl border px-4 py-3 text-xs", isDark ? "border-white/10 bg-[#1A1A1A] text-white" : "border-slate-200 bg-slate-50")}>
                        <option value="require">SSL zorunlu</option>
                        <option value="verify-full">SSL sertifikasını doğrula</option>
                      </select>
                      <textarea required rows={4} value={newSqlConfig.query} onChange={(event) => setNewSqlConfig((current) => ({ ...current, query: event.target.value }))} className={cn("md:col-span-2 rounded-xl border px-4 py-3 font-mono text-xs", isDark ? "border-white/10 bg-[#1A1A1A] text-white" : "border-slate-200 bg-slate-50")} placeholder="SELECT tarih, urun, adet, ciro FROM public.sales" />
                      <p className="md:col-span-2 text-[10px] opacity-55">Yalnızca salt-okunur SELECT sorguları çalışır. Host ayrıca sunucudaki SQL izin listesinde bulunmalıdır.</p>
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
                    disabled={isTestingConn || !isAdmin}
                    className={cn(
                      "px-6 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-all duration-200 shadow-sm flex items-center gap-2",
                      isDark
                        ? "bg-[#FFD700] text-black hover:bg-[#FFE57F]"
                        : "bg-[#4F46E5] text-white hover:bg-[#4338CA]",
                      isViewer && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    <Plus className="w-4 h-4" />
                    {isTestingConn ? 'Kaydediliyor...' : `${newConnType === 'postgresql' ? 'PostgreSQL' : 'REST'} Bağlantısını Kaydet`}
                  </button>
                </form>
              </div>

              {/* Active Connectors List */}
              <div className="space-y-4">
                <h4 className="text-sm font-bold uppercase tracking-widest opacity-60">Tanımlı Veri Konnektörleri</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {connections.map((conn) => {
                    const cfg = parseConnectionConfig(conn.config);
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
                              isDark ? "bg-sky-500/10 text-sky-400" : "bg-sky-50 text-sky-600"
                            )}>
                              {conn.type === 'postgresql' ? 'PostgreSQL' : 'REST API'}
                            </span>
                            <span className="text-[10px] opacity-40">ID: {conn.id}</span>
                          </div>
                          
                          <h5 className="font-bold text-sm">{conn.name}</h5>
                          <p className="text-[10px] opacity-50 mt-1 truncate">
                            {conn.type === 'postgresql'
                              ? `Sunucu: ${String(cfg.host || '—')}:${String(cfg.port || 5432)} / ${String(cfg.database || '—')}`
                              : `Endpoint: ${String(cfg.url || 'Yapılandırma kullanılamıyor')}`}
                          </p>

                          <div className={cn(
                            "mt-4 space-y-3 rounded-xl border p-3",
                            isDark ? "border-white/10 bg-white/[0.03]" : "border-slate-200 bg-slate-50"
                          )}>
                            <div className="flex items-center justify-between gap-3">
                              <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider opacity-70">
                                <Clock className="h-3.5 w-3.5" /> Otomatik Yenileme
                              </span>
                              <span className={cn(
                                "rounded-full px-2 py-1 text-[9px] font-black uppercase",
                                conn.schedule_enabled
                                  ? "bg-emerald-500/10 text-emerald-500"
                                  : "bg-slate-500/10 text-slate-400"
                              )}>
                                {conn.schedule_enabled ? 'Etkin' : 'Kapalı'}
                              </span>
                            </div>
                            <div className="flex gap-2">
                              <select
                                aria-label={`${conn.name} yenileme aralığı`}
                                value={scheduleDrafts[conn.id] || conn.schedule_interval_minutes || 60}
                                disabled={!isAdmin || Boolean(conn.schedule_enabled)}
                                onChange={(event) => setScheduleDrafts((current) => ({
                                  ...current,
                                  [conn.id]: Number(event.target.value)
                                }))}
                                className={cn(
                                  "min-w-0 flex-1 rounded-lg border px-2 py-2 text-[10px] font-bold outline-none",
                                  isDark ? "border-white/10 bg-[#1A1A1A] text-white" : "border-slate-200 bg-white text-slate-700",
                                  (!isAdmin || Boolean(conn.schedule_enabled)) && "opacity-60"
                                )}
                              >
                                <option value={15}>15 dakikada bir</option>
                                <option value={30}>30 dakikada bir</option>
                                <option value={60}>Saatlik</option>
                                <option value={360}>6 saatte bir</option>
                                <option value={1440}>Günlük</option>
                              </select>
                              <button
                                type="button"
                                disabled={!isAdmin || busyConnectionId === conn.id || conn.encryptionStatus !== 'encrypted'}
                                onClick={() => void handleScheduleConnection(conn)}
                                className={cn(
                                  "rounded-lg px-3 py-2 text-[9px] font-black uppercase tracking-wider",
                                  conn.schedule_enabled
                                    ? "bg-rose-500/10 text-rose-500"
                                    : "bg-indigo-500/10 text-indigo-500",
                                  (!isAdmin || busyConnectionId === conn.id || conn.encryptionStatus !== 'encrypted') && "cursor-not-allowed opacity-40"
                                )}
                              >
                                {conn.schedule_enabled ? 'Kapat' : 'Etkinleştir'}
                              </button>
                            </div>
                            <div className="space-y-1 text-[9px] opacity-55">
                              <p>
                                Son deneme: {conn.last_synced_at ? new Date(conn.last_synced_at).toLocaleString('tr-TR') : 'Henüz çalışmadı'}
                                {conn.last_sync_status && (
                                  <span className={cn("ml-2 font-bold", conn.last_sync_status === 'success' ? "text-emerald-500" : "text-rose-500")}>
                                    {conn.last_sync_status === 'success' ? 'Başarılı' : 'Hatalı'}
                                  </span>
                                )}
                              </p>
                              {conn.schedule_enabled && conn.next_sync_at && (
                                <p>Sonraki çalışma: {new Date(conn.next_sync_at).toLocaleString('tr-TR')}</p>
                              )}
                              {conn.last_sync_status === 'failure' && conn.last_sync_error && (
                                <p className="text-rose-500">{conn.last_sync_error}</p>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 border-t border-dashed border-white/10 pt-4 mt-4">
                          <button
                            disabled={isViewer || busyConnectionId === conn.id || conn.encryptionStatus !== 'encrypted'}
                            onClick={() => handleIngestConnection(conn.id)}
                            className={cn(
                              "flex flex-1 items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all",
                              isDark ? "bg-white/5 hover:bg-white/10 text-white" : "bg-slate-100 hover:bg-slate-200 text-slate-700",
                              (isViewer || busyConnectionId === conn.id || conn.encryptionStatus !== 'encrypted') && "opacity-40 cursor-not-allowed"
                            )}
                          >
                            <RefreshCw className={cn("w-3.5 h-3.5", busyConnectionId === conn.id && "animate-spin")} />
                            Şimdi Yenile
                          </button>

                          <button
                            type="button"
                            onClick={() => void toggleSyncHistory(conn.id)}
                            aria-expanded={expandedConnectionId === conn.id}
                            className={cn(
                              "flex items-center gap-1 rounded-lg px-3 py-2 text-[10px] font-bold uppercase",
                              isDark ? "bg-white/5 text-white" : "bg-slate-100 text-slate-700"
                            )}
                          >
                            Geçmiş
                            {expandedConnectionId === conn.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>

                          <button
                            disabled={!isAdmin}
                            onClick={() => handleDeleteConnection(conn.id)}
                            className={cn(
                              "p-2 text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors",
                              isViewer && "opacity-40 cursor-not-allowed"
                            )}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        {expandedConnectionId === conn.id && (
                          <div className={cn(
                            "mt-3 max-h-48 space-y-2 overflow-y-auto rounded-xl border p-3",
                            isDark ? "border-white/10 bg-black/20" : "border-slate-200 bg-slate-50"
                          )}>
                            {(syncRuns[conn.id] || []).map((run) => (
                              <div key={run.id} className="flex items-start justify-between gap-3 border-b border-white/5 pb-2 text-[9px] last:border-0 last:pb-0">
                                <div>
                                  <p className={cn("font-bold", run.status === 'success' ? "text-emerald-500" : "text-rose-500")}>
                                    {run.status === 'success' ? 'Başarılı' : 'Başarısız'}
                                  </p>
                                  <p className="mt-0.5 opacity-55">{new Date(run.finished_at).toLocaleString('tr-TR')}</p>
                                  {run.error_message && <p className="mt-1 text-rose-500">{run.error_message}</p>}
                                </div>
                                {run.status === 'success' && (
                                  <span className="whitespace-nowrap opacity-55">{run.row_count} satır · {run.column_count} kolon</span>
                                )}
                              </div>
                            ))}
                            {(syncRuns[conn.id] || []).length === 0 && (
                              <p className="py-2 text-center text-[9px] opacity-45">Henüz eşitleme geçmişi yok.</p>
                            )}
                          </div>
                        )}
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
                      {etlMessage.type === 'success'
                        ? <CheckCircle className="w-12 h-12 text-emerald-500 mx-auto" />
                        : <AlertTriangle className="w-12 h-12 text-rose-500 mx-auto" />}
                      <p className={cn("text-xs font-bold", etlMessage.type === 'success' ? "text-emerald-500" : "text-rose-500")}>{etlMessage.text}</p>
                      <p className="text-[10px] opacity-50">Sonuçlar yalnızca tamamlanan dönüşüm adımlarına dayanır; kaynak veri setleri korunur.</p>
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
                  Doküman Destekli Arama Havuzu
                </h3>
                <p className="text-xs opacity-60 mb-6">
                  PDF veya TXT kurumsal belgeleri yükleyin. Belgeler yerel olarak metin parçalarına ayrılır; ilgili parçalar AI sorgularında bağlam olarak seçilir.
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
                                doc.status === 'indexed' || doc.status === 'ready'
                                  ? (isDark ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-50 text-emerald-600")
                                  : "bg-amber-500/10 text-amber-400"
                              )}>
                                {doc.status === 'indexed' || doc.status === 'ready' ? 'Aramaya Hazır' : 'İşleniyor'}
                              </span>
                            </td>
                            <td className="py-4 px-6 opacity-60">
                              {new Date(doc.created_at).toLocaleDateString('tr-TR')}
                            </td>
                            <td className="py-4 px-6 text-right">
                              <button
                                disabled={!isAdmin}
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
                  Rolünüz sunucu tarafında uygulanır. Rol değişikliklerini yalnızca yetkili yönetici API üzerinden yapabilir.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[
                  { role: 'admin', label: 'Administrator', desc: 'Tam Yetki: Veri yazma, silme, konnektör ekleme ve yetkilendirmeleri yapabilir.' },
                  { role: 'analyst', label: 'Analyst', desc: 'Veri Analiz Yetkisi: Veri ekleyebilir ve inceleyebilir, ancak konnektörleri silemez.' },
                  { role: 'viewer', label: 'Viewer (Sınırlı)', desc: 'Salt Okunur Yetki: Veri setlerini inceleyebilir, ancak hiçbir silme/ekleme operasyonu yapamaz.' }
                ].map(r => (
                  <div
                    key={r.role}
                    className={cn(
                      "p-5 rounded-2xl border text-left flex flex-col justify-between",
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
                      {user.role.toLowerCase() === r.role ? 'Aktif Rol' : 'Yönetici Tarafından Atanabilir'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'notifications' && (
            <div className={cn(
              'space-y-6 rounded-2xl border p-6 shadow-sm',
              isDark ? 'border-white/5 bg-[#151515]' : 'border-slate-200 bg-white'
            )}>
              <div>
                <h3 className="flex items-center gap-2 text-lg font-bold uppercase tracking-wider"><Bell className="h-5 w-5 text-indigo-500" /> İş Bildirim Kanalları</h3>
                <p className="mt-1 text-xs opacity-60">KPI, veri eşitleme ve abonelik olaylarını kurum yöneticilerine e-posta, Slack veya Teams üzerinden iletin.</p>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <label className={cn('rounded-xl border p-4', isDark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50')}>
                  <span className="flex items-center justify-between text-xs font-bold"><span>Yönetici e-postaları</span><input type="checkbox" checked={notificationSettings.emailEnabled} disabled={!isAdmin} onChange={(event) => setNotificationSettings((current) => ({ ...current, emailEnabled: event.target.checked }))} /></span>
                  <p className="mt-2 text-[10px] opacity-50">Resend ve doğrulanmış gönderen adresi kullanılır.</p>
                </label>
                <div className={cn('rounded-xl border p-4', isDark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50')}>
                  <p className="text-xs font-bold">Slack {notificationSettings.slackConfigured && <span className="text-emerald-500">· bağlı</span>}</p>
                  <input type="url" value={slackWebhook} disabled={!isAdmin || removeSlack} onChange={(event) => setSlackWebhook(event.target.value)} className={cn('mt-3 w-full rounded-lg border px-3 py-2 text-xs', isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-white')} placeholder="https://hooks.slack.com/services/..." />
                  {notificationSettings.slackConfigured && <label className="mt-2 flex items-center gap-2 text-[10px]"><input type="checkbox" checked={removeSlack} onChange={(event) => setRemoveSlack(event.target.checked)} /> Kayıtlı Slack kanalını kaldır</label>}
                </div>
                <div className={cn('rounded-xl border p-4', isDark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50')}>
                  <p className="text-xs font-bold">Microsoft Teams {notificationSettings.teamsConfigured && <span className="text-emerald-500">· bağlı</span>}</p>
                  <input type="url" value={teamsWebhook} disabled={!isAdmin || removeTeams} onChange={(event) => setTeamsWebhook(event.target.value)} className={cn('mt-3 w-full rounded-lg border px-3 py-2 text-xs', isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-white')} placeholder="https://...webhook.office.com/..." />
                  {notificationSettings.teamsConfigured && <label className="mt-2 flex items-center gap-2 text-[10px]"><input type="checkbox" checked={removeTeams} onChange={(event) => setRemoveTeams(event.target.checked)} /> Kayıtlı Teams kanalını kaldır</label>}
                </div>
              </div>

              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest opacity-55">Gönderilecek olaylar</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    ['kpi_breach', 'KPI eşik ihlali'],
                    ['kpi_recovery', 'KPI yeniden sağlıklı'],
                    ['connector_failure', 'Konnektör hatası'],
                    ['connector_recovery', 'Konnektör düzeldi'],
                    ['billing', 'Abonelik ve ödeme'],
                  ].map(([event, label]) => (
                    <label key={event} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2 text-xs', isDark ? 'border-white/10' : 'border-slate-200')}>
                      <input type="checkbox" disabled={!isAdmin} checked={notificationSettings.events.includes(event as BusinessAlertEvent)} onChange={() => toggleNotificationEvent(event as BusinessAlertEvent)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {notificationMessage && <div className={cn('rounded-xl px-4 py-3 text-xs font-bold', notificationMessage.type === 'success' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500')}>{notificationMessage.text}</div>}
              <div className="flex flex-wrap gap-3">
                <button type="button" disabled={!isAdmin || notificationBusy} onClick={() => void saveNotifications()} className={cn('inline-flex items-center gap-2 rounded-xl px-5 py-3 text-xs font-bold uppercase', isDark ? 'bg-[#FFD700] text-black' : 'bg-indigo-600 text-white', (!isAdmin || notificationBusy) && 'opacity-40')}><Check className="h-4 w-4" /> Kaydet</button>
                <button type="button" disabled={!isAdmin || notificationBusy} onClick={() => void testNotifications()} className={cn('inline-flex items-center gap-2 rounded-xl border px-5 py-3 text-xs font-bold uppercase', isDark ? 'border-white/15' : 'border-slate-300', (!isAdmin || notificationBusy) && 'opacity-40')}><Send className="h-4 w-4" /> Test gönder</button>
              </div>
            </div>
          )}

          {activeTab === 'governance' && (
            <div className={cn('space-y-6 rounded-2xl border p-6 shadow-sm', isDark ? 'border-white/5 bg-[#151515]' : 'border-slate-200 bg-white')}>
              <div>
                <h3 className="flex items-center gap-2 text-lg font-bold uppercase tracking-wider"><Shield className="h-5 w-5 text-emerald-500" /> Veri Saklama ve Taşınabilirlik</h3>
                <p className="mt-1 text-xs opacity-60">KVKK/GDPR operasyonları için geçmiş kayıt saklama süresini yönetin ve kurum verisinin taşınabilir kopyasını alın.</p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <label className={cn('rounded-xl border p-4', isDark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50')}>
                  <span className="flex items-center justify-between text-xs font-bold"><span>Otomatik geçmiş temizliği</span><input type="checkbox" disabled={!isAdmin} checked={retentionPolicy.enabled} onChange={(event) => setRetentionPolicy((current) => ({ ...current, enabled: event.target.checked }))} /></span>
                  <p className="mt-2 text-[10px] opacity-50">Veri setleri ve belgeler korunur; audit, bildirim, analiz, eşitleme ve KPI geçmişleri süre dolunca temizlenir.</p>
                </label>
                <label className={cn('rounded-xl border p-4', isDark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50')}>
                  <span className="text-xs font-bold">Saklama süresi (gün)</span>
                  <input type="number" min={30} max={3650} disabled={!isAdmin} value={retentionPolicy.retentionDays} onChange={(event) => setRetentionPolicy((current) => ({ ...current, retentionDays: Number(event.target.value) }))} className={cn('mt-3 w-full rounded-lg border px-3 py-2 text-xs', isDark ? 'border-white/10 bg-black/20' : 'border-slate-200 bg-white')} />
                  <p className="mt-2 text-[10px] opacity-50">Son uygulama: {retentionPolicy.lastAppliedAt ? new Date(retentionPolicy.lastAppliedAt).toLocaleString('tr-TR') : 'Henüz uygulanmadı'}</p>
                </label>
              </div>
              {governanceMessage && <div className={cn('rounded-xl px-4 py-3 text-xs font-bold', governanceMessage.type === 'success' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500')}>{governanceMessage.text}</div>}
              <div className="flex flex-wrap gap-3">
                <button type="button" disabled={!isAdmin || governanceBusy} onClick={() => void saveRetentionPolicy()} className={cn('rounded-xl px-5 py-3 text-xs font-bold uppercase', isDark ? 'bg-[#FFD700] text-black' : 'bg-indigo-600 text-white', (!isAdmin || governanceBusy) && 'opacity-40')}>Politikayı kaydet</button>
                <button type="button" disabled={!isAdmin || governanceBusy} onClick={() => void applyRetentionNow()} className={cn('rounded-xl border px-5 py-3 text-xs font-bold uppercase text-rose-500', isDark ? 'border-rose-500/20' : 'border-rose-200', (!isAdmin || governanceBusy) && 'opacity-40')}>Şimdi uygula</button>
                <button type="button" disabled={!isAdmin || governanceBusy} onClick={() => void exportOrganizationData()} className={cn('rounded-xl border px-5 py-3 text-xs font-bold uppercase', isDark ? 'border-white/15' : 'border-slate-300', (!isAdmin || governanceBusy) && 'opacity-40')}>Kurum verisini dışa aktar</button>
              </div>
              <p className="text-[10px] leading-5 opacity-50">Dışa aktarım; veri setleri, belgeler, analizler, KPI tanımları, üyeler ve denetim kayıtlarını JSON olarak içerir. Şifrelenmiş bağlantı parolaları ve webhook adresleri dışa aktarılmaz.</p>
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
