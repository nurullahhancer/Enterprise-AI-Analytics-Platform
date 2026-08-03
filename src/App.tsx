import React, { useState, useEffect, useRef } from 'react';
import { ViewState, User, ChatMessage, OrganizationMembership } from './types';
import Login from './views/Login';
import Sidebar from './components/Sidebar';
import Dashboard from './views/Dashboard';
import DataImport from './views/DataImport';
import AIChat from './views/AIChat';
import Settings from './views/Settings';
import EnterpriseSuite from './views/EnterpriseSuite';
import SaaSManagement, { SaaSOrganization } from './views/SaaSManagement';
import DecisionCenter from './views/DecisionCenter';
import { apiFetch, authHeaders, clearAuthTokens, getApiUrl } from './lib/api';
import {
  LayoutDashboard,
  MessageSquare,
  Upload,
  Settings as SettingsIcon,
  Shield,
  UsersRound,
  CreditCard,
  Gauge,
  Menu,
  Activity,
  Building2,
} from 'lucide-react';
import { cn } from './lib/utils';

const createInitialChat = (): ChatMessage[] => [
  {
    id: '1',
    role: 'assistant',
    content: 'Merhaba! Verilerinizde neler olduğunu sade bir dille anlatabilirim. Örneğin “Gelecek ay kaç satış bekleniyor?” veya “En çok kazandıran ürün hangisi?” diye sorabilirsiniz.',
    timestamp: new Date()
  }
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isSessionLoading, setIsSessionLoading] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [organizations, setOrganizations] = useState<OrganizationMembership[]>([]);
  const [currentView, setCurrentView] = useState<ViewState>('import'); // Default to import so user uploads data first
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(createInitialChat);
  const mainContentRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('reai_theme') as 'light' | 'dark') || 'dark';
  });

  useEffect(() => {
    const root = window.document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('reai_theme', theme);
  }, [theme]);

  const restoreSession = async () => {
    setIsSessionLoading(true);
    setSessionError('');
    try {
      let response = await apiFetch(getApiUrl('/api/me'), { headers: authHeaders() });
      if (response.status === 403) {
        const errorBody = await response.clone().json().catch(() => null);
        if (errorBody?.error?.code === 'ORGANIZATION_ACCESS_DENIED') {
          localStorage.removeItem('reai_organization_id');
          response = await apiFetch(getApiUrl('/api/me'), { headers: authHeaders() });
        }
      }
      if (response.status === 401 || response.status === 403) {
        clearAuthTokens();
        setUser(null);
        setOrganizations([]);
        return;
      }
      if (!response.ok) throw new Error('Oturum doğrulanamadı.');

      const data = await response.json();
      if (!data?.user?.email) {
        clearAuthTokens();
        setUser(null);
        return;
      }
      setUser(data.user as User);
      const memberships = Array.isArray(data.organizations) ? data.organizations as OrganizationMembership[] : [];
      setOrganizations(memberships);
      const activeId = data.organization?.organization_id || data.user?.tenantId;
      if (activeId) localStorage.setItem('reai_organization_id', activeId);
    } catch {
      setSessionError('Sunucuya ulaşılamadığı için oturum doğrulanamadı.');
    } finally {
      setIsSessionLoading(false);
    }
  };

  useEffect(() => {
    void restoreSession();
  }, []);

  useEffect(() => {
    setIsMobileMenuOpen(false);
    mainContentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentView]);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMobileMenuOpen(false);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isMobileMenuOpen]);

  const handleLogin = (loggedUser: User) => {
    setUser(loggedUser);
    if (loggedUser.tenantId) localStorage.setItem('reai_organization_id', loggedUser.tenantId);
    setSessionError('');
    setChatMessages(createInitialChat());
    setCurrentView('import');
    void restoreSession();
  };

  const handleLogout = () => {
    void apiFetch(getApiUrl('/api/logout'), {
      method: 'POST',
      headers: authHeaders()
    }).catch(() => undefined);
    clearAuthTokens();
    localStorage.removeItem('reai_organization_id');
    setUser(null);
    setOrganizations([]);
    setChatMessages(createInitialChat());
    setCurrentView('import');
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  const handleOrganizationChange = async (organizationId: string) => {
    if (!organizationId || organizationId === localStorage.getItem('reai_organization_id')) return;
    localStorage.setItem('reai_organization_id', organizationId);
    setChatMessages(createInitialChat());
    setCurrentView('import');
    await restoreSession();
  };

  if (isSessionLoading) {
    return (
      <div className="app-viewport flex items-center justify-center bg-[#0B0F17] px-6 text-slate-100">
        <div className="flex items-center gap-3 text-xs font-semibold text-slate-400" role="status" aria-live="polite">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-blue-500" />
          Oturum doğrulanıyor...
        </div>
      </div>
    );
  }

  if (!user && sessionError) {
    return (
      <div className="app-viewport flex items-center justify-center bg-[#0B0F17] px-6 text-slate-100">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#111827] p-8 text-center shadow-xl">
          <h1 className="text-lg font-bold text-slate-100">Oturum doğrulaması başarısız</h1>
          <p className="mt-2 text-sm text-slate-400">{sessionError}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => void restoreSession()}
              className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-500 transition-colors"
            >
              Tekrar Dene
            </button>
            <button
              type="button"
              onClick={() => {
                clearAuthTokens();
                setSessionError('');
              }}
              className="flex-1 rounded-lg border border-slate-700 px-4 py-2.5 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition-colors"
            >
              Giriş Ekranı
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  const activeOrganizationId = localStorage.getItem('reai_organization_id') || user.tenantId || '';
  const activeMembership = organizations.find((organization) => organization.organization_id === activeOrganizationId) || organizations[0];
  const activeOrganization: SaaSOrganization | null = activeMembership ? {
    id: activeMembership.organization_id,
    name: activeMembership.organization_name,
    slug: activeMembership.organization_slug,
    role: activeMembership.role,
    planKey: activeMembership.plan_key
  } : null;

  const renderView = () => {
    switch (currentView) {
      case 'import':
        return (
          <DataImport
            user={user}
            onNextView={() => setCurrentView('dashboard')}
            onOpenEnterprise={() => setCurrentView('enterprise')}
          />
        );
      case 'dashboard':
        return <Dashboard />;
      case 'decisions':
        return <DecisionCenter user={user} />;
      case 'chat':
        return <AIChat messages={chatMessages} setMessages={setChatMessages} onOpenBilling={() => setCurrentView('billing')} canManageBilling={activeMembership?.role === 'admin'} />;
      case 'enterprise':
        return <EnterpriseSuite user={user} onUserUpdate={setUser} />;
      case 'team':
        return <SaaSManagement
          section="team"
          user={user}
          activeOrganization={activeOrganization}
          memberships={organizations.map((organization) => ({
            organizationId: organization.organization_id,
            organizationName: organization.organization_name,
            role: organization.role,
            status: organization.status
          }))}
          onOrganizationSwitch={(organization) => handleOrganizationChange(String(organization.id))}
          onContextRefresh={restoreSession}
        />;
      case 'billing':
        return <SaaSManagement
          section="billing"
          user={user}
          activeOrganization={activeOrganization}
          memberships={organizations.map((organization) => ({
            organizationId: organization.organization_id,
            organizationName: organization.organization_name,
            role: organization.role,
            status: organization.status
          }))}
          onOrganizationSwitch={(organization) => handleOrganizationChange(String(organization.id))}
          onContextRefresh={restoreSession}
        />;
      case 'settings':
        return <Settings user={user} onUserUpdate={setUser} onLogout={handleLogout} />;
      default:
        return (
          <DataImport
            user={user}
            onNextView={() => setCurrentView('dashboard')}
            onOpenEnterprise={() => setCurrentView('enterprise')}
          />
        );
    }
  };

  const mainTabs = [
    { id: 'import' as ViewState, label: 'Verilerim', mobileLabel: 'Veriler', icon: Upload },
    { id: 'dashboard' as ViewState, label: 'Sonuçlar ve Grafikler', mobileLabel: 'Sonuçlar', icon: LayoutDashboard },
    { id: 'decisions' as ViewState, label: 'Hedefler ve Uyarılar', mobileLabel: 'Hedefler', icon: Gauge },
    { id: 'chat' as ViewState, label: 'Asistana Sor', mobileLabel: 'Asistan', icon: MessageSquare },
    { id: 'enterprise' as ViewState, label: 'Veri Bağlantıları', mobileLabel: 'Bağlantılar', icon: Shield },
    { id: 'team' as ViewState, label: 'Ekibim', mobileLabel: 'Ekip', icon: UsersRound },
    { id: 'billing' as ViewState, label: 'Paketim', mobileLabel: 'Paket', icon: CreditCard },
    { id: 'settings' as ViewState, label: 'Hesabım', mobileLabel: 'Hesabım', icon: SettingsIcon },
  ];
  const mobileTabs = mainTabs.slice(0, 4);
  const activeTab = mainTabs.find((tab) => tab.id === currentView) || mainTabs[0];
  const secondaryTabActive = mainTabs.slice(4).some((tab) => tab.id === currentView);

  return (
    <div className={cn(
      "app-viewport flex flex-col overflow-hidden font-sans transition-colors duration-200 md:flex-row",
      theme === 'dark' ? "bg-[#0B0F17] text-slate-100" : "bg-[#F8FAFC] text-slate-900"
    )}>
      <div className="hidden md:flex shrink-0">
        <Sidebar
          currentView={currentView}
          onChangeView={setCurrentView}
          user={user}
          onLogout={handleLogout}
          theme={theme}
          onToggleTheme={toggleTheme}
          organizations={organizations}
          activeOrganizationId={activeOrganizationId}
          onOrganizationChange={handleOrganizationChange}
        />
      </div>

      <main className={cn(
        "flex h-full min-w-0 flex-1 flex-col overflow-hidden pb-[calc(68px+env(safe-area-inset-bottom))] transition-colors duration-200 md:pb-0",
        theme === 'dark' ? "bg-[#0F172A]/40" : "bg-[#F1F5F9]"
      )}>
        <header className={cn(
          "hidden h-16 shrink-0 items-center justify-between gap-6 border-b px-6 md:flex lg:px-8",
          theme === 'dark'
            ? "border-slate-800/80 bg-[#111827]/90"
            : "border-slate-200 bg-white/95"
        )}>
          <div className="flex min-w-0 items-center gap-3">
            <div className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border",
              theme === 'dark' ? "border-slate-700 bg-slate-800 text-blue-400" : "border-blue-100 bg-blue-50 text-blue-600"
            )}>
              <activeTab.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <span>Ana Sayfa</span>
                <span aria-hidden="true">/</span>
                <span className={cn("font-medium", theme === 'dark' ? "text-slate-200" : "text-slate-700")}>{activeTab.mobileLabel}</span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className={cn(
              "hidden items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium xl:flex",
              theme === 'dark'
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-400"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            )}>
              <Activity className="h-3.5 w-3.5 text-emerald-500" />
              Sistem Hazır
            </div>
            <div className={cn(
              "flex max-w-64 items-center gap-2.5 rounded-lg border px-3 py-1.5 text-xs",
              theme === 'dark' ? "border-slate-800 bg-slate-800/60 text-slate-300" : "border-slate-200 bg-slate-50 text-slate-700"
            )}>
              <Building2 className={cn("h-4 w-4 shrink-0", theme === 'dark' ? "text-blue-400" : "text-blue-600")} />
              <span className="truncate font-medium">{activeMembership?.organization_name || 'Çalışma Alanı'}</span>
            </div>
            <div className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white shadow-sm",
              theme === 'dark' ? "bg-slate-800 text-blue-400 border border-slate-700" : "bg-blue-600 text-white"
            )} title={user.name} aria-label={`Oturum sahibi: ${user.name}`}>
              {user.name.charAt(0).toLocaleUpperCase('tr-TR')}
            </div>
          </div>
        </header>

        <header className={cn(
          "relative z-30 flex shrink-0 items-center justify-between gap-3 border-b px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:hidden",
          theme === 'dark' ? "border-white/10 bg-[#0E0E0E]" : "border-slate-200 bg-white"
        )}>
          <div className="flex min-w-0 items-center gap-3">
            <div className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              theme === 'dark' ? "bg-[#FFD700]" : "bg-[#4F46E5]"
            )} aria-hidden="true">
              <div className={cn("h-4 w-4 rounded-full", theme === 'dark' ? "bg-black" : "bg-white")} />
            </div>
            <div className="min-w-0">
              <p className={cn(
                "truncate text-[10px] font-bold uppercase tracking-widest",
                theme === 'dark' ? "text-white/40" : "text-slate-400"
              )}>
                {activeMembership?.organization_name || 'ReAi Çalışma Alanı'}
              </p>
              <h1 className="truncate text-sm font-black uppercase tracking-tight">{activeTab.label}</h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            aria-label="Uygulama menüsünü aç"
            aria-expanded={isMobileMenuOpen}
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-colors",
              theme === 'dark'
                ? "border-white/10 bg-white/5 text-white/80 active:bg-white/10"
                : "border-slate-200 bg-slate-50 text-slate-700 active:bg-slate-100"
            )}
          >
            <Menu className="h-5 w-5" />
          </button>
        </header>

        <div ref={mainContentRef} id="main-content" className={cn(
          "app-workspace min-h-0 flex-1 overflow-y-auto overscroll-contain",
          currentView === 'chat' ? "p-2 md:p-5" : "p-4 md:p-6"
        )}>
          <div key={currentView} className="animate-fade-in-up transition-all duration-300 h-full">
            {renderView()}
          </div>
        </div>
      </main>

      <nav className={cn(
        "fixed bottom-0 left-0 right-0 z-40 border-t px-2 pb-[env(safe-area-inset-bottom)] transition-colors duration-300 md:hidden",
        theme === 'dark' ? "bg-[#0A0A0A] border-white/10" : "bg-white border-slate-200"
      )} aria-label="Ana menü">
        <div className="flex h-[68px] items-stretch justify-around">
          {mobileTabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              onClick={() => { setCurrentView(tab.id); }}
              aria-current={currentView === tab.id ? 'page' : undefined}
              className={cn(
                "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 transition-colors",
                currentView === tab.id
                  ? (theme === 'dark' ? "text-[#FFD700]" : "text-[#4F46E5]")
                  : (theme === 'dark' ? "text-white/40 active:text-white/60" : "text-slate-400 active:text-slate-600")
              )}
            >
              {currentView === tab.id && (
                <span className={cn(
                  "absolute left-1/2 top-0 h-0.5 w-8 -translate-x-1/2 rounded-full",
                  theme === 'dark' ? "bg-[#FFD700]" : "bg-[#4F46E5]"
                )} />
              )}
              <tab.icon className="w-5 h-5" />
              <span className="w-full truncate px-1 text-[10px] font-bold">{tab.mobileLabel}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            aria-label="Diğer uygulama bölümlerini aç"
            aria-expanded={isMobileMenuOpen}
            className={cn(
              "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 transition-colors",
              secondaryTabActive || isMobileMenuOpen
                ? (theme === 'dark' ? "text-[#FFD700]" : "text-[#4F46E5]")
                : (theme === 'dark' ? "text-white/40 active:text-white/60" : "text-slate-400 active:text-slate-600")
            )}
          >
            {(secondaryTabActive || isMobileMenuOpen) && (
              <span className={cn(
                "absolute left-1/2 top-0 h-0.5 w-8 -translate-x-1/2 rounded-full",
                theme === 'dark' ? "bg-[#FFD700]" : "bg-[#4F46E5]"
              )} />
            )}
            <Menu className="h-5 w-5" />
            <span className="text-[10px] font-bold">Menü</span>
          </button>
        </div>
      </nav>

      {isMobileMenuOpen && (
        <div className="fixed inset-0 z-[70] md:hidden" role="dialog" aria-modal="true" aria-label="Uygulama menüsü">
          <button
            type="button"
            className="absolute inset-0 bg-black/65 backdrop-blur-sm"
            onClick={() => setIsMobileMenuOpen(false)}
            aria-label="Uygulama menüsünü kapat"
          />
          <div className="absolute inset-y-0 left-0 max-w-[88vw] shadow-2xl">
            <Sidebar
              currentView={currentView}
              onChangeView={setCurrentView}
              user={user}
              onLogout={handleLogout}
              onClose={() => setIsMobileMenuOpen(false)}
              theme={theme}
              onToggleTheme={toggleTheme}
              organizations={organizations}
              activeOrganizationId={activeOrganizationId}
              onOrganizationChange={(organizationId) => {
                setIsMobileMenuOpen(false);
                void handleOrganizationChange(organizationId);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
