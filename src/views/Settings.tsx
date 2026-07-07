import React, { useState, useEffect } from 'react';
import { User, ShieldAlert, KeyRound, Check, AlertTriangle, UserMinus } from 'lucide-react';
import { cn } from '../lib/utils';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import { User as UserType } from '../types';

interface SettingsProps {
  user: UserType;
  onUserUpdate: (updatedUser: UserType) => void;
  onLogout: () => void;
}

export default function Settings({ user, onUserUpdate, onLogout }: SettingsProps) {
  const [name, setName] = useState(user.name);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isDark, setIsDark] = useState(true);
  
  // States for notifications
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);
  
  // Delete account modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    setIsDark(document.documentElement.classList.contains('dark'));
    return () => observer.disconnect();
  }, []);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setProfileMessage({ type: 'error', text: 'İsim alanı boş bırakılamaz.' });
      return;
    }

    setIsUpdatingProfile(true);
    setProfileMessage(null);

    try {
      const res = await fetch(getApiUrl('/api/user'), {
        method: 'PUT',
        headers: {
          ...jsonHeaders(),
          ...authHeaders()
        },
        body: JSON.stringify({ name: name.trim() })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Profil güncellenirken bir hata oluştu.');
      }
      
      onUserUpdate({ ...user, name: name.trim() });
      setProfileMessage({ type: 'success', text: 'Profil bilgileriniz başarıyla güncellendi.' });
    } catch (err: any) {
      setProfileMessage({ type: 'error', text: err.message });
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setPasswordMessage({ type: 'error', text: 'Şifre alanı boş bırakılamaz.' });
      return;
    }
    if (password !== confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'Şifreler uyuşmuyor.' });
      return;
    }

    setIsUpdatingPassword(true);
    setPasswordMessage(null);

    try {
      const res = await fetch(getApiUrl('/api/user'), {
        method: 'PUT',
        headers: {
          ...jsonHeaders(),
          ...authHeaders()
        },
        body: JSON.stringify({ name: user.name, password })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Şifre güncellenirken bir hata oluştu.');
      }
      
      setPassword('');
      setConfirmPassword('');
      setPasswordMessage({ type: 'success', text: 'Şifreniz başarıyla güncellendi.' });
    } catch (err: any) {
      setPasswordMessage({ type: 'error', text: err.message });
    } finally {
      setIsUpdatingPassword(false);
    }
  };

  const handleDeleteAccount = async () => {
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(getApiUrl('/api/user'), {
        method: 'DELETE',
        headers: {
          ...authHeaders()
        }
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || 'Hesap silinirken bir hata oluştu.');
      }
      
      setShowDeleteModal(false);
      onLogout();
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-8 pb-16">
      <div>
        <h1 className="text-3xl font-black tracking-tight uppercase italic">
          Hesap Ayarları
        </h1>
        <p className={cn(
          "text-sm mt-1",
          isDark ? "text-white/60" : "text-slate-500"
        )}>
          Profil bilgiilerinizi yönetin, şifrenizi güncelleyin veya hesabınızı silin.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Profile Card */}
        <div className={cn(
          "p-6 rounded-2xl border transition-colors duration-200 shadow-sm",
          isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200/80"
        )}>
          <div className="flex items-center gap-3 mb-6">
            <User className={cn("w-5 h-5", isDark ? "text-[#FFD700]" : "text-[#4F46E5]")} />
            <h2 className="text-lg font-bold uppercase tracking-wider">Profil Bilgileri</h2>
          </div>

          <form onSubmit={handleUpdateProfile} className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">E-posta</label>
              <input
                type="text"
                disabled
                value={user.email}
                className={cn(
                  "w-full px-4 py-3 rounded-xl border text-xs font-medium cursor-not-allowed opacity-50",
                  isDark ? "bg-white/5 border-white/5 text-white/60" : "bg-slate-50 border-slate-200 text-slate-400"
                )}
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">Görünen İsim</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={cn(
                  "w-full px-4 py-3 rounded-xl border text-xs font-medium focus:outline-none transition-all duration-200",
                  isDark 
                    ? "bg-[#1A1A1A] border-white/10 text-white focus:border-[#FFD700]" 
                    : "bg-slate-50 border-slate-200 text-slate-800 focus:border-[#4F46E5]"
                )}
                placeholder="İsminiz"
              />
            </div>

            {profileMessage && (
              <div className={cn(
                "p-3 rounded-xl text-xs font-bold flex items-center gap-2",
                profileMessage.type === 'success' 
                  ? (isDark ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-50 text-emerald-600")
                  : (isDark ? "bg-rose-500/10 text-rose-400" : "bg-rose-50 text-rose-600")
              )}>
                <Check className="w-4 h-4 shrink-0" />
                <span>{profileMessage.text}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isUpdatingProfile}
              className={cn(
                "w-full py-3.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all duration-200 shadow-sm",
                isDark
                  ? "bg-[#FFD700] text-black hover:bg-[#FFE57F] active:scale-[0.98]"
                  : "bg-[#4F46E5] text-white hover:bg-[#4338CA] active:scale-[0.98]"
              )}
            >
              {isUpdatingProfile ? 'Güncelleniyor...' : 'Profili Kaydet'}
            </button>
          </form>
        </div>

        {/* Password Card */}
        <div className={cn(
          "p-6 rounded-2xl border transition-colors duration-200 shadow-sm",
          isDark ? "bg-[#151515] border-white/5" : "bg-white border-slate-200/80"
        )}>
          <div className="flex items-center gap-3 mb-6">
            <KeyRound className={cn("w-5 h-5", isDark ? "text-[#FFD700]" : "text-[#4F46E5]")} />
            <h2 className="text-lg font-bold uppercase tracking-wider">Şifre Değiştir</h2>
          </div>

          <form onSubmit={handleUpdatePassword} className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">Yeni Şifre</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={cn(
                  "w-full px-4 py-3 rounded-xl border text-xs font-medium focus:outline-none transition-all duration-200",
                  isDark 
                    ? "bg-[#1A1A1A] border-white/10 text-white focus:border-[#FFD700]" 
                    : "bg-slate-50 border-slate-200 text-slate-800 focus:border-[#4F46E5]"
                )}
                placeholder="••••••••"
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-widest opacity-60 mb-2">Yeni Şifre (Tekrar)</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={cn(
                  "w-full px-4 py-3 rounded-xl border text-xs font-medium focus:outline-none transition-all duration-200",
                  isDark 
                    ? "bg-[#1A1A1A] border-white/10 text-white focus:border-[#FFD700]" 
                    : "bg-slate-50 border-slate-200 text-slate-800 focus:border-[#4F46E5]"
                )}
                placeholder="••••••••"
              />
            </div>

            {passwordMessage && (
              <div className={cn(
                "p-3 rounded-xl text-xs font-bold flex items-center gap-2",
                passwordMessage.type === 'success' 
                  ? (isDark ? "bg-emerald-500/10 text-emerald-400" : "bg-emerald-50 text-emerald-600")
                  : (isDark ? "bg-rose-500/10 text-rose-400" : "bg-rose-50 text-rose-600")
              )}>
                <Check className="w-4 h-4 shrink-0" />
                <span>{passwordMessage.text}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isUpdatingPassword}
              className={cn(
                "w-full py-3.5 rounded-xl text-xs font-bold uppercase tracking-widest transition-all duration-200 shadow-sm",
                isDark
                  ? "bg-[#FFD700] text-black hover:bg-[#FFE57F] active:scale-[0.98]"
                  : "bg-[#4F46E5] text-white hover:bg-[#4338CA] active:scale-[0.98]"
              )}
            >
              {isUpdatingPassword ? 'Şifre Güncelleniyor...' : 'Şifreyi Değiştir'}
            </button>
          </form>
        </div>
      </div>

      {/* Dangerous Zone Card */}
      <div className={cn(
        "p-6 rounded-2xl border transition-colors duration-200 shadow-sm",
        isDark ? "bg-[#151515] border-rose-500/20" : "bg-rose-50/30 border-rose-200"
      )}>
        <div className="flex items-center gap-3 mb-4">
          <ShieldAlert className="w-5 h-5 text-rose-500" />
          <h2 className="text-lg font-bold uppercase tracking-wider text-rose-500">Tehlikeli Alan</h2>
        </div>

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="max-w-xl">
            <p className="text-sm font-bold">Hesabı Kalıcı Olarak Sil</p>
            <p className={cn(
              "text-xs mt-1",
              isDark ? "text-white/50" : "text-slate-500"
            )}>
              Hesabınızı silmek tüm veri setlerinizi, analiz panellerinizi ve AI sohbet geçmişinizi geri döndürülemez şekilde silecektir.
            </p>
          </div>

          <button
            onClick={() => setShowDeleteModal(true)}
            className="px-6 py-3.5 bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white rounded-xl text-xs font-bold uppercase tracking-widest transition-all duration-200 shrink-0 shadow-sm"
          >
            Hesabımı Sil
          </button>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm transition-all duration-300">
          <div className={cn(
            "w-full max-w-md p-6 rounded-2xl border shadow-xl animate-in fade-in zoom-in duration-200",
            isDark ? "bg-[#121212] border-white/10 text-white" : "bg-white border-slate-200 text-slate-800"
          )}>
            <div className="flex items-center gap-3 mb-4 text-rose-500">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h3 className="text-lg font-black uppercase tracking-wider">Hesabınızı Siliyorsunuz</h3>
            </div>
            
            <p className={cn(
              "text-sm mb-6",
              isDark ? "text-white/70" : "text-slate-600"
            )}>
              Bu işlem kalıcıdır ve geri alınamaz. Hesabınızla ilişkili tüm veriler tamamen silinecektir. Devam etmek istiyor musunuz?
            </p>

            {deleteError && (
              <div className="p-3 mb-4 bg-rose-500/10 text-rose-400 rounded-xl text-xs font-bold flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>{deleteError}</span>
              </div>
            )}

            <div className="flex gap-4">
              <button
                disabled={isDeleting}
                onClick={() => setShowDeleteModal(false)}
                className={cn(
                  "flex-1 py-3 rounded-xl text-xs font-bold uppercase tracking-widest transition-all",
                  isDark ? "bg-white/5 hover:bg-white/10 text-white" : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                )}
              >
                İptal
              </button>
              
              <button
                disabled={isDeleting}
                onClick={handleDeleteAccount}
                className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white rounded-xl text-xs font-bold uppercase tracking-widest transition-all flex items-center justify-center gap-2"
              >
                <UserMinus className="w-4 h-4" />
                {isDeleting ? 'Siliniyor...' : 'Evet, Sil'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
