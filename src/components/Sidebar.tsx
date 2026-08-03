import React from 'react';
import { 
  LayoutDashboard, 
  Upload, 
  MessageSquare, 
  LogOut,
  X,
  Sun,
  Moon,
  Settings as SettingsIcon,
  Shield,
  Bell,
  Download,
  Building2,
  UsersRound,
  CreditCard,
  Gauge,
  ChevronDown,
  Sparkles
} from 'lucide-react';
import { ViewState, User, OrganizationMembership } from '../types';
import { cn } from '../lib/utils';
import { apiFetch, authHeaders, getApiUrl } from '../lib/api';
import { getApkDownloadUrl, shouldShowApkDownload } from '../lib/downloads';

interface SidebarProps {
  currentView: ViewState;
  onChangeView: (view: ViewState) => void;
  user: User;
  onLogout: () => void;
  onClose?: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  organizations: OrganizationMembership[];
  activeOrganizationId: string;
  onOrganizationChange: (organizationId: string) => void;
}

export default function Sidebar({ 
  currentView, 
  onChangeView, 
  user, 
  onLogout, 
  onClose,
  theme,
  onToggleTheme,
  organizations,
  activeOrganizationId,
  onOrganizationChange
}: SidebarProps) {
  const navSections = [
    {
      label: 'Veriler ve Sonuçlar',
      items: [
        { id: 'import', label: 'Verilerim', helper: 'Dosya yükleyin ve düzenleyin', icon: Upload },
        { id: 'dashboard', label: 'Sonuçları Gör', helper: 'Grafiklerle genel durumu görün', icon: LayoutDashboard },
        { id: 'decisions', label: 'Hedefler ve Uyarılar', helper: 'Hedeflerinizi takip edin', icon: Gauge },
        { id: 'chat', label: 'Asistana Sor', helper: 'Verileriniz hakkında soru sorun', icon: MessageSquare },
      ],
    },
    {
      label: 'Hesap ve Yönetim',
      items: [
        { id: 'enterprise', label: 'Veri Bağlantıları', helper: 'Başka sistemlerden veri alın', icon: Shield },
        { id: 'team', label: 'Ekibim', helper: 'Kişileri ve yetkilerini yönetin', icon: UsersRound },
        { id: 'billing', label: 'Paketim', helper: 'Paketinizi ve kullanımı görün', icon: CreditCard },
        { id: 'settings', label: 'Hesabım', helper: 'Bilgilerinizi ve şifrenizi değiştirin', icon: SettingsIcon },
      ],
    },
  ] as const;

  const [notifications, setNotifications] = React.useState<any[]>([]);
  const [showNotifications, setShowNotifications] = React.useState(false);
  const showApkDownload = shouldShowApkDownload();
  const unreadCount = notifications.filter((notification) => notification.read_status === 0).length;
  const roleLabel = user.role === 'admin' ? 'Yönetici' : user.role === 'analyst' ? 'Analist' : 'Görüntüleyici';

  const fetchNotifications = async () => {
    try {
      const res = await apiFetch(getApiUrl('/api/enterprise/notifications'), { headers: authHeaders() });
      if (res.ok) setNotifications(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  React.useEffect(() => {
    void fetchNotifications();
    const refreshVisibleNotifications = () => {
      if (document.visibilityState === 'visible') void fetchNotifications();
    };
    const interval = window.setInterval(refreshVisibleNotifications, 30000);
    document.addEventListener('visibilitychange', refreshVisibleNotifications);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshVisibleNotifications);
    };
  }, [activeOrganizationId]);

  const handleMarkRead = async () => {
    try {
      await apiFetch(getApiUrl('/api/enterprise/notifications/read'), { method: 'POST', headers: authHeaders() });
      fetchNotifications();
    } catch (err) {
      console.error(err);
    }
  };

  const handleNavClick = (view: ViewState) => {
    onChangeView(view);
    onClose?.();
  };

  return (
    <div className={cn(
      "app-viewport flex w-[min(19rem,90vw)] flex-col border-r transition-colors duration-200 md:w-[17.5rem]",
      theme === 'dark' 
        ? "bg-[#0B0F17] text-slate-100 border-slate-800" 
        : "bg-white text-slate-900 border-slate-200"
    )}>
      {/* Brand Header */}
      <div className={cn(
        "flex items-center justify-between border-b px-5 py-4",
        theme === 'dark' ? "border-slate-800" : "border-slate-100"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg shadow-sm border",
            theme === 'dark' ? "border-slate-700 bg-slate-800 text-blue-400" : "border-blue-100 bg-blue-50 text-blue-600"
          )}>
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight">ReAI</h1>
              <span className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                theme === 'dark' ? "bg-slate-800 text-slate-400 border border-slate-700" : "bg-slate-100 text-slate-500"
              )}>Kurumsal</span>
            </div>
            <p className={cn(
              "text-xs",
              theme === 'dark' ? "text-slate-400" : "text-slate-500"
            )}>Veri Analiz Platformu</p>
          </div>
        </div>
        {onClose && (
          <button 
            type="button"
            onClick={onClose} 
            aria-label="Uygulama menüsünü kapat"
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg transition-colors md:hidden",
              theme === 'dark' 
                ? "text-slate-400 hover:text-slate-200 hover:bg-slate-800" 
                : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            )}
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Organization Switcher */}
      <div className={cn("border-b px-4 py-3", theme === 'dark' ? "border-slate-800" : "border-slate-100")}>
        <label htmlFor="organization-switcher" className={cn(
          "mb-1.5 block px-1 text-xs font-medium",
          theme === 'dark' ? "text-slate-400" : "text-slate-500"
        )}>
          Çalışma Alanı
        </label>
        <div className="relative">
          <Building2 className={cn(
            "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2",
            theme === 'dark' ? "text-slate-400" : "text-slate-500"
          )} />
          <select
            id="organization-switcher"
            value={activeOrganizationId}
            onChange={(event) => onOrganizationChange(event.target.value)}
            className={cn(
              "min-h-10 w-full appearance-none rounded-lg border py-2 pl-9 pr-8 text-xs font-semibold outline-none transition-colors",
              theme === 'dark'
                ? "border-slate-800 bg-slate-900/80 text-slate-200 hover:bg-slate-800"
                : "border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100"
            )}
          >
            {organizations.map((organization) => (
              <option key={organization.organization_id} value={organization.organization_id}>
                {organization.organization_name}
              </option>
            ))}
          </select>
          <ChevronDown className={cn(
            "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2",
            theme === 'dark' ? "text-slate-400" : "text-slate-400"
          )} />
        </div>
      </div>

      {/* Navigation Sections */}
      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-4">
        {navSections.map((section) => (
          <section key={section.label} aria-label={section.label}>
            <p className={cn(
              "mb-2 px-2 text-xs font-semibold uppercase tracking-wider",
              theme === 'dark' ? "text-slate-400" : "text-slate-500"
            )}>{section.label}</p>
            <div className="space-y-1">
              {section.items.map((item) => {
                const active = currentView === item.id;
                return (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => handleNavClick(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      "group relative flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150",
                      active
                        ? (theme === 'dark'
                            ? "border-blue-500/30 bg-blue-950/40 text-blue-300 font-semibold"
                            : "border-blue-200 bg-blue-50/80 text-blue-900 font-semibold")
                        : (theme === 'dark'
                            ? "border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                            : "border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900")
                    )}
                  >
                    <span className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
                      active
                        ? (theme === 'dark' ? "bg-blue-600 text-white" : "bg-blue-600 text-white")
                        : (theme === 'dark' ? "bg-slate-800/70 text-slate-400 group-hover:text-slate-200" : "bg-slate-100 text-slate-500 group-hover:text-slate-700")
                    )}>
                      <item.icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{item.label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {/* Sidebar Footer */}
      <div className={cn(
        "border-t p-3 space-y-2",
        theme === 'dark' ? "border-slate-800" : "border-slate-100"
      )}>
        <div className="relative">
          <div className={cn("grid gap-2", showApkDownload ? "grid-cols-3" : "grid-cols-2")}>
            <button
              type="button"
              onClick={() => {
                setShowNotifications(!showNotifications);
                if (!showNotifications) void handleMarkRead();
              }}
              aria-label="Bildirimleri göster"
              className={cn(
                "relative flex min-h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors",
                theme === 'dark' ? "border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800" : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
              )}
            >
              <Bell className="h-3.5 w-3.5 text-blue-500" />
              Bildirim
              {unreadCount > 0 && <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[9px] font-bold text-white">{unreadCount}</span>}
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Açık görünüme geç' : 'Koyu görünüme geç'}
              className={cn(
                "flex min-h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors",
                theme === 'dark' ? "border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800" : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
              )}
            >
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5 text-amber-400" /> : <Moon className="h-3.5 w-3.5 text-slate-600" />}
              Görünüm
            </button>
            {showApkDownload && (
              <a
                href={getApkDownloadUrl()}
                download
                aria-label="Android uygulamasını indir"
                className={cn(
                  "flex min-h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors",
                  theme === 'dark' ? "border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800" : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
                )}
              >
                <Download className="h-3.5 w-3.5 text-blue-500" />
                APK
              </a>
            )}
          </div>

          {showNotifications && (
            <div className={cn(
              "absolute bottom-full left-0 right-0 z-50 mb-2 max-h-64 space-y-2 overflow-y-auto rounded-xl border p-4 shadow-xl",
              theme === 'dark' ? "border-slate-800 bg-[#111827] text-slate-200" : "border-slate-200 bg-white text-slate-800"
            )}>
              <div className={cn("flex items-center justify-between border-b pb-2", theme === 'dark' ? "border-slate-800" : "border-slate-100")}>
                <span className="text-xs font-bold">Bildirimler</span>
                <button type="button" onClick={() => setShowNotifications(false)} className="text-xs text-slate-400 hover:text-slate-200">Kapat</button>
              </div>
              <div className={cn("divide-y", theme === 'dark' ? "divide-slate-800" : "divide-slate-100")}>
                {notifications.slice(0, 5).map((notification) => (
                  <div key={notification.id} className="py-2 first:pt-0 last:pb-0">
                    <p className="text-xs font-semibold">{notification.title}</p>
                    <p className="mt-0.5 text-xs opacity-70">{notification.message}</p>
                  </div>
                ))}
                {notifications.length === 0 && <p className="py-3 text-center text-xs text-slate-400">Yeni bildirim yok.</p>}
              </div>
            </div>
          )}
        </div>

        <div className={cn(
          "flex items-center gap-2.5 rounded-lg border p-2",
          theme === 'dark' ? "border-slate-800 bg-slate-900/60" : "border-slate-200 bg-slate-50"
        )}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-blue-600 text-xs font-bold text-white shadow-sm">
            {user.name.charAt(0).toLocaleUpperCase('tr-TR')}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold">{user.name}</p>
            <p className="truncate text-[11px] text-slate-400">{roleLabel}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              onLogout();
              onClose?.();
            }}
            aria-label="Hesaptan çıkış yap"
            title="Çıkış yap"
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
              theme === 'dark' ? "text-slate-400 hover:bg-slate-800 hover:text-slate-200" : "text-slate-400 hover:bg-slate-200 hover:text-rose-600"
            )}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
