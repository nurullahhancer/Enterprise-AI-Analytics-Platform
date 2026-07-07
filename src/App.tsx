import React, { useState, useEffect } from 'react';
import { ViewState, User, ChatMessage } from './types';
import Login from './views/Login';
import Sidebar from './components/Sidebar';
import Dashboard from './views/Dashboard';
import DataImport from './views/DataImport';
import AIChat from './views/AIChat';
import Settings from './views/Settings';
import EnterpriseSuite from './views/EnterpriseSuite';
import {
  LayoutDashboard,
  MessageSquare,
  Upload,
  Settings as SettingsIcon,
  Shield,
} from 'lucide-react';
import { cn } from './lib/utils';

const createInitialChat = (): ChatMessage[] => [
  {
    id: '1',
    role: 'assistant',
    content: 'Merhaba! Ben ReAi Asistanı. Şirket verilerinizle ilgili doğal dilde sorgular yapabilir, trendleri analiz edebilir veya tahminler isteyebilirsiniz. Size nasıl yardımcı olabilirim?',
    timestamp: new Date()
  }
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [currentView, setCurrentView] = useState<ViewState>('import'); // Default to import so user uploads data first
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(createInitialChat);
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

  const handleLogin = (loggedUser: User) => {
    setUser(loggedUser);
    setChatMessages(createInitialChat());
    setCurrentView('import');
  };

  const handleLogout = () => {
    localStorage.removeItem('reai_token');
    setUser(null);
    setChatMessages(createInitialChat());
    setCurrentView('import');
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  };

  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  const renderView = () => {
    switch (currentView) {
      case 'import':
        return <DataImport onNextView={() => setCurrentView('dashboard')} />;
      case 'dashboard':
        return <Dashboard />;
      case 'chat':
        return <AIChat messages={chatMessages} setMessages={setChatMessages} />;
      case 'enterprise':
        return <EnterpriseSuite user={user} onUserUpdate={setUser} />;
      case 'settings':
        return <Settings user={user} onUserUpdate={setUser} onLogout={handleLogout} />;
      default:
        return <DataImport onNextView={() => setCurrentView('dashboard')} />;
    }
  };

  const mainTabs = [
    { id: 'import' as ViewState, label: 'Veri Kaynakları', icon: Upload },
    { id: 'dashboard' as ViewState, label: 'Analiz Paneli', icon: LayoutDashboard },
    { id: 'chat' as ViewState, label: 'AI & Raporlama', icon: MessageSquare },
    { id: 'enterprise' as ViewState, label: 'Kurumsal', icon: Shield },
    { id: 'settings' as ViewState, label: 'Ayarlar', icon: SettingsIcon },
  ];

  return (
    <div className={cn(
      "flex flex-col md:flex-row h-screen overflow-hidden font-sans select-none transition-colors duration-300",
      theme === 'dark' ? "bg-[#0E0E0E] text-[#F0F0F0]" : "bg-[#F8FAFC] text-[#0F172A]"
    )}>
      <div className="hidden md:flex shrink-0">
        <Sidebar
          currentView={currentView}
          onChangeView={setCurrentView}
          user={user}
          onLogout={handleLogout}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      </div>

      <main className={cn(
        "flex-1 h-full overflow-y-auto pb-[72px] md:pb-0 transition-colors duration-300",
        theme === 'dark' ? "bg-[#111111]" : "bg-[#F1F5F9]"
      )}>
        {renderView()}
      </main>

      <nav className={cn(
        "md:hidden fixed bottom-0 left-0 right-0 z-40 px-2 pb-[env(safe-area-inset-bottom)] border-t transition-colors duration-300",
        theme === 'dark' ? "bg-[#0A0A0A] border-white/10" : "bg-white border-slate-200"
      )}>
        <div className="flex items-center justify-around h-[68px]">
          {mainTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { setCurrentView(tab.id); }}
              className={cn(
                "flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors",
                currentView === tab.id
                  ? (theme === 'dark' ? "text-[#FFD700]" : "text-[#4F46E5]")
                  : (theme === 'dark' ? "text-white/40 active:text-white/60" : "text-slate-400 active:text-slate-600")
              )}
            >
              <tab.icon className="w-5 h-5" />
              <span className="text-[10px] font-bold uppercase tracking-wider">{tab.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
