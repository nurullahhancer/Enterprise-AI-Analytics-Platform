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
  Bell
} from 'lucide-react';
import { ViewState, User } from '../types';
import { cn } from '../lib/utils';
import { authHeaders, getApiUrl } from '../lib/api';

interface SidebarProps {
  currentView: ViewState;
  onChangeView: (view: ViewState) => void;
  user: User;
  onLogout: () => void;
  onClose?: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export default function Sidebar({ 
  currentView, 
  onChangeView, 
  user, 
  onLogout, 
  onClose,
  theme,
  onToggleTheme
}: SidebarProps) {
  const navItems = [
    { id: 'import', label: 'Veri Kaynakları', icon: Upload },
    { id: 'dashboard', label: 'Analiz Paneli', icon: LayoutDashboard },
    { id: 'chat', label: 'AI & Raporlama', icon: MessageSquare },
    { id: 'enterprise', label: 'Kurumsal Yönetim', icon: Shield },
    { id: 'settings', label: 'Ayarlar', icon: SettingsIcon },
  ] as const;

  const [notifications, setNotifications] = React.useState<any[]>([]);
  const [showNotifications, setShowNotifications] = React.useState(false);

  const fetchNotifications = async () => {
    try {
      const res = await fetch(getApiUrl('/api/enterprise/notifications'), { headers: authHeaders() });
      if (res.ok) setNotifications(await res.json());
    } catch (err) {
      console.error(err);
    }
  };

  React.useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 5000); // refresh every 5s
    return () => clearInterval(interval);
  }, []);

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
      "w-72 h-screen flex flex-col border-r transition-colors duration-300",
      theme === 'dark' 
        ? "bg-[#0E0E0E] text-[#F0F0F0] border-white/10" 
        : "bg-white text-slate-800 border-slate-200"
    )}>
      <div className={cn(
        "p-8 flex items-center justify-between border-b",
        theme === 'dark' ? "border-white/10" : "border-slate-100"
      )}>
        <div className="flex items-center gap-4">
          <div className={cn(
            "w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-transform hover:scale-105 duration-300",
            theme === 'dark' ? "bg-[#FFD700]" : "bg-[#4F46E5]"
          )}>
            <div className={cn(
              "w-4 h-4 rounded-full",
              theme === 'dark' ? "bg-black" : "bg-white"
            )}></div>
          </div>
          <h1 className="text-2xl font-black tracking-tighter uppercase italic">ReAi</h1>
        </div>
        {onClose && (
          <button 
            onClick={onClose} 
            className={cn(
              "md:hidden p-2 rounded-lg transition-colors",
              theme === 'dark' 
                ? "text-white/60 hover:text-white hover:bg-white/5" 
                : "text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            )}
          >
            <X className="w-6 h-6" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-8 px-6 space-y-4">
        <div className={cn(
          "text-[10px] uppercase tracking-[0.4em] mb-6 font-bold",
          theme === 'dark' ? "opacity-30 text-white" : "text-slate-400"
        )}>
          Platform Modülleri
        </div>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => handleNavClick(item.id)}
            className={cn(
              "w-full flex items-center gap-4 px-4 py-3.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all duration-200 border",
              currentView === item.id 
                ? (theme === 'dark' 
                    ? "bg-white/10 text-[#FFD700] border-white/10" 
                    : "bg-indigo-50 text-[#4F46E5] border-indigo-100/50 shadow-sm")
                : (theme === 'dark'
                    ? "opacity-60 hover:opacity-100 hover:bg-white/5 border-transparent"
                    : "text-slate-600 hover:bg-slate-50 border-transparent")
            )}
          >
            <item.icon className="w-5 h-5 shrink-0" />
            {item.label}
          </button>
        ))}
      </div>

      <div className={cn(
        "p-6 border-t",
        theme === 'dark' ? "border-white/10" : "border-slate-100"
      )}>
        {/* Notification Bell Panel */}
        <div className="relative mb-4">
          <button
            onClick={() => {
              setShowNotifications(!showNotifications);
              if (!showNotifications) handleMarkRead();
            }}
            className={cn(
              "w-full flex items-center justify-between px-4 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border",
              theme === 'dark'
                ? "bg-white/5 border-white/5 text-white/80 hover:bg-white/10"
                : "bg-slate-50 border-slate-200/60 text-slate-700 hover:bg-slate-100"
            )}
          >
            <span className="flex items-center gap-3">
              <Bell className="w-4 h-4 text-[#FFD700]" />
              Bildirimler
            </span>
            {notifications.filter(n => n.read_status === 0).length > 0 && (
              <span className="bg-rose-600 text-white rounded-full px-2 py-0.5 text-[9px] font-black">
                {notifications.filter(n => n.read_status === 0).length} Yeni
              </span>
            )}
          </button>

          {showNotifications && (
            <div className={cn(
              "absolute bottom-full left-0 right-0 mb-2 z-50 p-4 rounded-xl border shadow-xl max-h-60 overflow-y-auto space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-150",
              theme === 'dark' ? "bg-[#151515] border-white/10 text-white" : "bg-white border-slate-200 text-slate-800"
            )}>
              <div className="flex items-center justify-between pb-2 border-b border-white/5">
                <span className="text-[10px] font-black uppercase tracking-wider opacity-60">Sistem Bildirimleri</span>
                <button onClick={() => setShowNotifications(false)} className="text-[9px] font-bold opacity-45 hover:opacity-100">Kapat</button>
              </div>
              <div className="divide-y divide-white/5">
                {notifications.slice(0, 5).map(n => (
                  <div key={n.id} className="py-2 first:pt-0 last:pb-0">
                    <p className="text-[11px] font-bold">{n.title}</p>
                    <p className="text-[9px] opacity-60 mt-0.5">{n.message}</p>
                  </div>
                ))}
                {notifications.length === 0 && (
                  <p className="text-[10px] opacity-40 text-center py-4">Bildirim bulunmuyor.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Theme Toggle Button */}
        <button
          onClick={onToggleTheme}
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 mb-4 rounded-xl text-xs font-bold uppercase tracking-widest transition-all border",
            theme === 'dark'
              ? "bg-white/5 border-white/5 text-white/80 hover:bg-white/10"
              : "bg-slate-50 border-slate-200/60 text-slate-700 hover:bg-slate-100"
          )}
        >
          <span className="flex items-center gap-3">
            {theme === 'dark' ? <Moon className="w-4 h-4 text-[#FFD700]" /> : <Sun className="w-4 h-4 text-amber-500" />}
            {theme === 'dark' ? "Koyu Tema" : "Açık Tema"}
          </span>
          <span className="text-[10px] opacity-40">Değiştir</span>
        </button>

        <div className={cn(
          "flex items-center gap-3 px-4 py-3 mb-4 rounded-xl border",
          theme === 'dark' 
            ? "bg-white/5 border-white/5" 
            : "bg-slate-50 border-slate-100"
        )}>
          <div className={cn(
            "w-8 h-8 rounded-lg flex items-center justify-center font-bold text-white shadow-sm shrink-0",
            theme === 'dark' ? "bg-gradient-to-tr from-pink-500 to-yellow-500" : "bg-gradient-to-tr from-indigo-500 to-purple-500"
          )}>
            {user.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold truncate">{user.name}</p>
            <p className="text-[10px] opacity-40 uppercase tracking-tighter truncate">{user.email}</p>
          </div>
        </div>
        
        <button
          onClick={() => {
            onLogout();
            onClose?.();
          }}
          className={cn(
            "w-full flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-all",
            theme === 'dark' 
              ? "opacity-60 hover:opacity-100 hover:bg-white/5" 
              : "text-slate-600 hover:bg-slate-100"
          )}
        >
          <LogOut className="w-5 h-5" />
          Çıkış Yap
        </button>
      </div>
    </div>
  );
}
