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
import { authHeaders, getApiUrl } from '../lib/api';
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
      const res = await fetch(getApiUrl('/api/enterprise/notifications'), { headers: authHeaders() });
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
      await fetch(getApiUrl('/api/enterprise/notifications/read'), { method: 'POST', headers: authHeaders() });
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
      "app-viewport flex w-[min(19rem,90vw)] flex-col border-r transition-colors duration-300 md:w-[18rem]",
      theme === 'dark' 
        ? "bg-[#0E0E0E] text-[#F0F0F0] border-white/10" 
        : "bg-white text-slate-800 border-slate-200"
    )}>
      <div className={cn(
        "flex items-center justify-between border-b px-5 py-5 md:px-5",
        theme === 'dark' ? "border-white/10" : "border-slate-100"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "relative flex h-11 w-11 items-center justify-center rounded-2xl shadow-lg",
            theme === 'dark' ? "bg-[#FFD700] text-black" : "bg-[#4F46E5] text-white"
          )}>
            <Sparkles className="h-5 w-5" />
            <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[#0E0E0E] bg-emerald-500" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <h1 className="text-2xl font-black tracking-tighter uppercase italic">ReAi</h1>
              <span className={cn(
                "rounded-md px-1.5 py-0.5 text-[7px] font-black uppercase tracking-wider",
                theme === 'dark' ? "bg-white/10 text-white/45" : "bg-slate-100 text-slate-500"
            )}>Hazır</span>
            </div>
            <p className={cn(
              "mt-0.5 text-[8px] font-bold uppercase tracking-[0.18em]",
              theme === 'dark' ? "text-white/30" : "text-slate-400"
            )}>Verilerinizi Kolayca Anlayın</p>
          </div>
        </div>
        {onClose && (
          <button 
            type="button"
            onClick={onClose} 
            aria-label="Uygulama menüsünü kapat"
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-xl transition-colors md:hidden",
              theme === 'dark' 
                ? "text-white/60 hover:text-white hover:bg-white/5" 
                : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            )}
          >
            <X className="w-6 h-6" />
          </button>
        )}
      </div>

      <div className={cn("border-b px-4 py-4", theme === 'dark' ? "border-white/10" : "border-slate-100")}>
        <label htmlFor="organization-switcher" className={cn(
          "mb-2 block px-1 text-[9px] font-bold uppercase tracking-[0.22em]",
          theme === 'dark' ? "text-white/40" : "text-slate-400"
        )}>
          Şirket veya Ekip
        </label>
        <div className="relative">
          <Building2 className={cn(
            "pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2",
            theme === 'dark' ? "text-[#FFD700]" : "text-[#4F46E5]"
          )} />
          <select
            id="organization-switcher"
            value={activeOrganizationId}
            onChange={(event) => onOrganizationChange(event.target.value)}
            className={cn(
              "min-h-12 w-full appearance-none rounded-2xl border py-2.5 pl-10 pr-9 text-xs font-bold outline-none transition-colors",
              theme === 'dark'
                ? "border-white/10 bg-white/[0.055] text-white hover:bg-white/[0.08]"
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
            "pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2",
            theme === 'dark' ? "text-white/35" : "text-slate-400"
          )} />
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4 md:py-5">
        {navSections.map((section) => (
          <section key={section.label} aria-label={section.label}>
            <p className={cn(
              "mb-2 px-3 text-[9px] font-bold uppercase tracking-[0.24em]",
              theme === 'dark' ? "text-white/25" : "text-slate-400"
            )}>{section.label}</p>
            <div className="space-y-1.5">
              {section.items.map((item) => {
                const active = currentView === item.id;
                return (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => handleNavClick(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      "group relative flex min-h-14 w-full items-center gap-3 overflow-hidden rounded-2xl border px-3 py-2.5 text-left transition-all duration-200",
                      active
                        ? (theme === 'dark'
                            ? "border-[#FFD700]/20 bg-[#FFD700]/10 text-white shadow-[inset_0_0_0_1px_rgba(255,215,0,0.03)]"
                            : "border-indigo-100 bg-indigo-50 text-slate-900 shadow-sm")
                        : (theme === 'dark'
                            ? "border-transparent text-white/55 hover:bg-white/5 hover:text-white"
                            : "border-transparent text-slate-500 hover:bg-slate-50 hover:text-slate-900")
                    )}
                  >
                    {active && (
                      <span className={cn(
                        "absolute inset-y-3 left-0 w-1 rounded-r-full",
                        theme === 'dark' ? "bg-[#FFD700]" : "bg-[#4F46E5]"
                      )} />
                    )}
                    <span className={cn(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors",
                      active
                        ? (theme === 'dark' ? "bg-[#FFD700] text-black" : "bg-[#4F46E5] text-white")
                        : (theme === 'dark' ? "bg-white/5 group-hover:bg-white/10" : "bg-slate-100 group-hover:bg-white")
                    )}>
                      <item.icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-bold">{item.label}</span>
                      <span className={cn(
                        "mt-0.5 block truncate text-[9px]",
                        active
                          ? (theme === 'dark' ? "text-white/45" : "text-indigo-500/70")
                          : (theme === 'dark' ? "text-white/25" : "text-slate-400")
                      )}>{item.helper}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className={cn(
        "border-t p-3",
        theme === 'dark' ? "border-white/10" : "border-slate-100"
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
                "relative flex min-h-11 items-center justify-center gap-2 rounded-xl border text-[10px] font-bold transition-colors",
                theme === 'dark' ? "border-white/10 bg-white/5 text-white/65 hover:bg-white/10" : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
              )}
            >
              <Bell className={cn("h-4 w-4", theme === 'dark' ? "text-[#FFD700]" : "text-indigo-600")} />
              Bildirim
              {unreadCount > 0 && <span className="absolute right-2 top-1.5 min-w-4 rounded-full bg-rose-600 px-1 text-center text-[8px] leading-4 text-white">{unreadCount}</span>}
            </button>
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Açık görünüme geç' : 'Koyu görünüme geç'}
              className={cn(
                "flex min-h-11 items-center justify-center gap-2 rounded-xl border text-[10px] font-bold transition-colors",
                theme === 'dark' ? "border-white/10 bg-white/5 text-white/65 hover:bg-white/10" : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
              )}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4 text-[#FFD700]" /> : <Moon className="h-4 w-4 text-indigo-600" />}
              Görünüm
            </button>
            {showApkDownload && (
              <a
                href={getApkDownloadUrl()}
                download
                aria-label="Android uygulamasını indir"
                className={cn(
                  "flex min-h-11 items-center justify-center gap-2 rounded-xl border text-[10px] font-bold transition-colors",
                  theme === 'dark' ? "border-white/10 bg-white/5 text-white/65 hover:bg-white/10" : "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                )}
              >
                <Download className={cn("h-4 w-4", theme === 'dark' ? "text-[#FFD700]" : "text-indigo-600")} />
                Uygulama
              </a>
            )}
          </div>

          {showNotifications && (
            <div className={cn(
              "absolute bottom-full left-0 right-0 z-50 mb-2 max-h-72 space-y-2 overflow-y-auto rounded-2xl border p-4 shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-150",
              theme === 'dark' ? "border-white/10 bg-[#151515] text-white" : "border-slate-200 bg-white text-slate-800"
            )}>
              <div className={cn("flex items-center justify-between border-b pb-2", theme === 'dark' ? "border-white/10" : "border-slate-100")}>
                <span className="text-xs font-bold">Bildirimler</span>
                <button type="button" onClick={() => setShowNotifications(false)} className="min-h-9 px-2 text-[10px] font-bold opacity-50 hover:opacity-100">Kapat</button>
              </div>
              <div className={cn("divide-y", theme === 'dark' ? "divide-white/5" : "divide-slate-100")}>
                {notifications.slice(0, 5).map((notification) => (
                  <div key={notification.id} className="py-2 first:pt-0 last:pb-0">
                    <p className="text-[11px] font-bold">{notification.title}</p>
                    <p className="mt-0.5 text-[10px] leading-4 opacity-60">{notification.message}</p>
                  </div>
                ))}
                {notifications.length === 0 && <p className="py-4 text-center text-[10px] opacity-45">Yeni bildiriminiz yok.</p>}
              </div>
            </div>
          )}
        </div>

        <div className={cn(
          "mt-2 flex items-center gap-3 rounded-2xl border p-2.5",
          theme === 'dark' ? "border-white/10 bg-white/[0.04]" : "border-slate-200 bg-slate-50"
        )}>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-500 text-sm font-black text-white shadow-sm">
            {user.name.charAt(0).toLocaleUpperCase('tr-TR')}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold">{user.name}</p>
            <p className="mt-0.5 truncate text-[9px] opacity-45">{roleLabel} · {user.email}</p>
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
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
              theme === 'dark' ? "text-white/40 hover:bg-white/10 hover:text-white" : "text-slate-400 hover:bg-white hover:text-rose-600"
            )}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
