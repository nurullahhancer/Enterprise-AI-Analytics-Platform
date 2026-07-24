import React, { useEffect, useState } from 'react';
import { Building2, Download, LogIn, Lock, Mail, User as UserIcon } from 'lucide-react';
import { User } from '../types';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import { getApkDownloadUrl, shouldShowApkDownload } from '../lib/downloads';

interface LoginProps {
  onLogin: (user: User) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [isRegister, setIsRegister] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  const [invitationToken, setInvitationToken] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [resetToken, setResetToken] = useState('');
  const [preferredOrganizationId, setPreferredOrganizationId] = useState('');
  const showApkDownload = shouldShowApkDownload();

  useEffect(() => {
    fetch(getApiUrl('/api/config'))
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((config) => setRegistrationEnabled(config.registrationEnabled === true))
      .catch(() => setRegistrationEnabled(false));

    const params = new URLSearchParams(window.location.search);
    const invitation = params.get('invite') || '';
    const verification = params.get('verifyEmail') || '';
    const passwordReset = params.get('resetPassword') || '';
    if (invitation) {
      setInvitationToken(invitation);
      fetch(getApiUrl(`/api/invitation/preview?token=${encodeURIComponent(invitation)}`))
        .then((response) => response.ok ? response.json() : Promise.reject())
        .then((data) => {
          setEmail(String(data.invitation?.email || ''));
          setOrganizationName(String(data.invitation?.organizationName || ''));
          setIsRegister(true);
          setRegistrationEnabled(true);
        })
        .catch(() => setErrorMsg('Davet bağlantısı geçersiz veya süresi dolmuş.'));
    }
    if (verification) {
      fetch(getApiUrl('/api/verify-email'), {
        method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ token: verification })
      })
        .then(async (response) => ({ ok: response.ok, data: await response.json() }))
        .then(({ ok, data }) => ok ? setSuccessMsg(data.message) : setErrorMsg(data.error?.message || 'E-posta doğrulanamadı.'))
        .catch(() => setErrorMsg('E-posta doğrulama servisine ulaşılamadı.'));
    }
    if (passwordReset) setResetToken(passwordReset);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    
    const userEmail = email.trim().toLowerCase();
    const userName = name.trim();
    
    try {
      if (resetToken) {
        const response = await fetch(getApiUrl('/api/reset-password'), {
          method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ token: resetToken, password })
        });
        const data = await response.json();
        if (!response.ok) setErrorMsg(data.error?.message || 'Şifre yenilenemedi.');
        else {
          setSuccessMsg(data.message);
          setResetToken('');
          setPassword('');
          window.history.replaceState({}, '', window.location.pathname);
        }
      } else if (forgotMode) {
        const response = await fetch(getApiUrl('/api/forgot-password'), {
          method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: userEmail })
        });
        const data = await response.json();
        if (!response.ok) setErrorMsg(data.error?.message || 'İstek tamamlanamadı.');
        else {
          setSuccessMsg(data.message);
          setForgotMode(false);
        }
      } else if (isRegister) {
        const response = await fetch(getApiUrl('/api/register'), {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            email: userEmail,
            name: userName,
            password,
            organizationName: organizationName.trim() || undefined,
            invitationToken: invitationToken || undefined
          }),
        });
        const data = await response.json();

        if (response.ok) {
          setSuccessMsg(data.message || 'Kayıt başarılı! Şimdi giriş yapabilirsiniz.');
          if (data.organizationId) setPreferredOrganizationId(String(data.organizationId));
          if (invitationToken) {
            setInvitationToken('');
            window.history.replaceState({}, '', window.location.pathname);
          }
          setIsRegister(false);
          setName('');
          setPassword('');
        } else {
          setErrorMsg(data.error?.message || 'Kayıt sırasında bir hata oluştu.');
        }
      } else {
        const response = await fetch(getApiUrl('/api/login'), {
          method: 'POST',
          headers: { ...jsonHeaders(), ...(preferredOrganizationId ? { 'X-Organization-Id': preferredOrganizationId } : {}) },
          body: JSON.stringify({ email: userEmail, password }),
        });
        const data = await response.json();
        
        if (response.ok && data.user) {
          if (data.token) localStorage.setItem('reai_token', data.token);
          else localStorage.removeItem('reai_token');
          const organizationId = data.organization?.organization_id || data.user?.tenantId;
          if (organizationId) localStorage.setItem('reai_organization_id', organizationId);
          if (invitationToken) {
            const accepted = await fetch(getApiUrl('/api/saas/invitations/accept'), {
              method: 'POST',
              headers: { ...jsonHeaders(), ...authHeaders() },
              body: JSON.stringify({ token: invitationToken })
            });
            const acceptedData = await accepted.json().catch(() => null);
            if (!accepted.ok) {
              setErrorMsg(acceptedData?.error?.message || 'Ekip daveti kabul edilemedi.');
              return;
            }
            if (acceptedData.organizationId) localStorage.setItem('reai_organization_id', acceptedData.organizationId);
            window.history.replaceState({}, '', window.location.pathname);
          }
          onLogin(data.user);
        } else {
          setErrorMsg(data.error?.message || 'E-posta veya şifre hatalı.');
        }
      }
    } catch (err) {
      setErrorMsg('Sunucuya bağlanılamadı. Lütfen internetinizi kontrol edin.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-viewport flex flex-col justify-start overflow-y-auto bg-[#0E0E0E] px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+2rem)] font-sans text-[#F0F0F0] sm:justify-center sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto w-full max-w-sm text-center">
        <div className="flex justify-center">
          <div className="w-14 h-14 md:w-16 md:h-16 bg-[#FFD700] rounded-full flex items-center justify-center shadow-lg">
             <div className="w-5 h-5 md:w-6 md:h-6 bg-black rounded-full"></div>
          </div>
        </div>
        <h2 className="mt-5 text-[36px] md:text-[40px] font-black uppercase tracking-tighter leading-none">
          Re<span className="text-[#FFD700] italic">Ai</span>
        </h2>
        <p className="mt-3 text-[10px] md:text-xs font-mono uppercase tracking-[0.2em] opacity-40">
          Analytics & Prediction Platform
        </p>
      </div>

      <div className="mx-auto mt-7 w-full max-w-sm md:mt-10">
        <div className="rounded-3xl border border-white/10 bg-white/5 px-5 py-6 backdrop-blur-md sm:px-8 sm:py-8">
          {successMsg && (
            <div role="status" aria-live="polite" className="mb-6 p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs rounded-xl font-bold uppercase tracking-wider">
              {successMsg}
            </div>
          )}
          {errorMsg && (
            <div role="alert" aria-live="assertive" className="mb-6 p-4 bg-pink-500/10 border border-pink-500/20 text-pink-400 text-xs rounded-xl font-bold uppercase tracking-wider">
              {errorMsg}
            </div>
          )}

          <form className="space-y-5 sm:space-y-6" onSubmit={handleSubmit}>
            {isRegister && !forgotMode && !resetToken && (
              <div>
                <label htmlFor="name" className="block text-[10px] font-bold uppercase tracking-widest text-[#F0F0F0] opacity-60 mb-2">
                  Ad Soyad
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <UserIcon className="h-5 w-5 opacity-40" />
                  </div>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="block w-full pl-12 pr-4 py-4 bg-black/50 border border-white/10 rounded-xl focus:ring-1 focus:ring-[#FFD700] focus:border-[#FFD700] text-sm transition-all text-[#F0F0F0] placeholder-white/20"
                    placeholder="Adınız Soyadınız"
                  />
                </div>
              </div>
            )}

            {isRegister && !invitationToken && !forgotMode && !resetToken && (
              <div>
                <label htmlFor="organizationName" className="block text-[10px] font-bold uppercase tracking-widest text-[#F0F0F0] opacity-60 mb-2">
                  Çalışma Alanı
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Building2 className="h-5 w-5 opacity-40" />
                  </div>
                  <input
                    id="organizationName"
                    type="text"
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    className="block w-full pl-12 pr-4 py-4 bg-black/50 border border-white/10 rounded-xl focus:ring-1 focus:ring-[#FFD700] focus:border-[#FFD700] text-sm transition-all text-[#F0F0F0] placeholder-white/20"
                    placeholder="Şirket veya ekip adı"
                  />
                </div>
              </div>
            )}

            {!resetToken && <div>
              <label htmlFor="email" className="block text-[10px] font-bold uppercase tracking-widest text-[#F0F0F0] opacity-60 mb-2">
                Kurumsal E-posta
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Mail className="h-5 w-5 opacity-40" />
                </div>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    autoCapitalize="none"
                    spellCheck={false}
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="block w-full pl-12 pr-4 py-4 bg-black/50 border border-white/10 rounded-xl focus:ring-1 focus:ring-[#FFD700] focus:border-[#FFD700] text-sm transition-all text-[#F0F0F0] placeholder-white/20"
                  placeholder="isim@sirket.com"
                />
              </div>
            </div>}

            {!forgotMode && <div>
              <label htmlFor="password" className="block text-[10px] font-bold uppercase tracking-widest text-[#F0F0F0] opacity-60 mb-2">
                {resetToken ? 'Yeni Şifre' : 'Şifre'}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 opacity-40" />
                </div>
                <input
                  id="password"
                    name="password"
                    type="password"
                    autoComplete={isRegister || resetToken ? 'new-password' : 'current-password'}
                    minLength={isRegister || resetToken ? 12 : undefined}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-12 pr-4 py-4 bg-black/50 border border-white/10 rounded-xl focus:ring-1 focus:ring-[#FFD700] focus:border-[#FFD700] text-sm transition-all text-[#F0F0F0] placeholder-white/20"
                  placeholder="••••••••"
                />
              </div>
            </div>}

            <div className="pt-2">
              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex justify-center items-center gap-3 py-4 px-4 border border-[#FFD700] rounded-xl shadow-sm text-sm font-bold uppercase tracking-widest text-black bg-[#FFD700] active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-black/20 border-t-black rounded-full animate-spin"></div>
                    İşlem Yapılıyor...
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    {resetToken ? 'Şifreyi Yenile' : forgotMode ? 'Yenileme Bağlantısı Gönder' : isRegister ? 'Kayıt Ol' : 'Giriş Yap'}
                    <LogIn className="w-5 h-5" />
                  </div>
                )}
              </button>
            </div>
          </form>

          {/* Mode Switcher */}
          <div className="mt-6 text-center">
            {!isRegister && !forgotMode && !resetToken && <button
              onClick={() => { setForgotMode(true); setErrorMsg(''); setSuccessMsg(''); setPassword(''); }}
              type="button"
              className="mb-4 block w-full text-[10px] font-bold uppercase tracking-widest text-white/50 hover:text-white"
            >
              Şifremi Unuttum
            </button>}
            {forgotMode && <button
              onClick={() => { setForgotMode(false); setErrorMsg(''); setSuccessMsg(''); }}
              type="button"
              className="text-xs font-bold uppercase tracking-widest text-[#FFD700]"
            >
              Giriş Ekranına Dön
            </button>}
            {!forgotMode && !resetToken && (registrationEnabled ? <button
                onClick={() => {
                  setIsRegister(!isRegister);
                  setErrorMsg('');
                  setSuccessMsg('');
                  setPassword('');
                }}
                type="button"
              className="text-xs font-bold uppercase tracking-widest text-[#FFD700] hover:text-[#FFD700]/80 transition-colors"
            >
              {isRegister ? 'Zaten hesabınız var mı? Giriş Yapın' : invitationToken ? 'Davet ile yeni hesap oluşturun' : 'Hesabınız yok mu? Kayıt Olun'}
            </button> : <p className="text-[10px] font-bold uppercase tracking-widest text-white/35">Yeni hesap kaydı yönetici tarafından kapalıdır.</p>)}
          </div>

          {showApkDownload && <div className="mt-5 border-t border-white/10 pt-5">
            <a
              href={getApkDownloadUrl()}
              download
              className="flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-bold uppercase tracking-widest text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              Android APK İndir
              <Download className="h-4 w-4" />
            </a>
          </div>}
        </div>
      </div>
    </div>
  );
}
