import React, { useEffect, useState } from 'react';
import { Building2, Download, LogIn, Lock, Mail, User as UserIcon } from 'lucide-react';
import { User } from '../types';
import { apiFetch, authHeaders, getApiUrl, jsonHeaders, storeAuthTokens } from '../lib/api';
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
    apiFetch(getApiUrl('/api/config'))
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((config) => setRegistrationEnabled(config.registrationEnabled === true))
      .catch(() => setRegistrationEnabled(false));

    const params = new URLSearchParams(window.location.search);
    const invitation = params.get('invite') || '';
    const verification = params.get('verifyEmail') || '';
    const passwordReset = params.get('resetPassword') || '';
    if (invitation) {
      setInvitationToken(invitation);
      apiFetch(getApiUrl(`/api/invitation/preview?token=${encodeURIComponent(invitation)}`))
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
      apiFetch(getApiUrl('/api/verify-email'), {
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
        const response = await apiFetch(getApiUrl('/api/reset-password'), {
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
        const response = await apiFetch(getApiUrl('/api/forgot-password'), {
          method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ email: userEmail })
        });
        const data = await response.json();
        if (!response.ok) setErrorMsg(data.error?.message || 'İstek tamamlanamadı.');
        else {
          setSuccessMsg(data.message);
          setForgotMode(false);
        }
      } else if (isRegister) {
        const response = await apiFetch(getApiUrl('/api/register'), {
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
        const response = await apiFetch(getApiUrl('/api/login'), {
          method: 'POST',
          headers: { ...jsonHeaders(), ...(preferredOrganizationId ? { 'X-Organization-Id': preferredOrganizationId } : {}) },
          body: JSON.stringify({ email: userEmail, password }),
        });
        const data = await response.json();
        
        if (response.ok && data.user) {
          storeAuthTokens(data);
          const organizationId = data.organization?.organization_id || data.user?.tenantId;
          if (organizationId) localStorage.setItem('reai_organization_id', organizationId);
          if (invitationToken) {
            const accepted = await apiFetch(getApiUrl('/api/saas/invitations/accept'), {
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
    <div className="app-viewport flex flex-col justify-start overflow-y-auto bg-[#0B0F17] px-5 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-[calc(env(safe-area-inset-top)+2rem)] font-sans text-slate-100 sm:justify-center sm:px-6 sm:py-10 lg:px-8">
      <div className="mx-auto w-full max-w-sm text-center">
        <div className="flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md">
            <span className="text-xl font-bold tracking-tight">Re</span>
          </div>
        </div>
        <h2 className="mt-4 text-2xl font-bold tracking-tight text-slate-100">
          ReAI Platform
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Kurumsal Veri & Analiz Yönetimi
        </p>
      </div>

      <div className="mx-auto mt-6 w-full max-w-sm">
        <div className="rounded-xl border border-slate-800 bg-[#111827] px-6 py-6 shadow-xl sm:px-8 sm:py-8">
          {successMsg && (
            <div role="status" aria-live="polite" className="mb-5 p-3 bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs rounded-lg font-medium">
              {successMsg}
            </div>
          )}
          {errorMsg && (
            <div role="alert" aria-live="assertive" className="mb-5 p-3 bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs rounded-lg font-medium">
              {errorMsg}
            </div>
          )}

          <form className="space-y-4" onSubmit={handleSubmit}>
            {isRegister && !forgotMode && !resetToken && (
              <div>
                <label htmlFor="name" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Ad Soyad
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                    <UserIcon className="h-4 w-4" />
                  </div>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    autoComplete="name"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="block w-full pl-9 pr-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 text-xs text-slate-100 placeholder-slate-500 transition-colors"
                    placeholder="Adınız Soyadınız"
                  />
                </div>
              </div>
            )}

            {isRegister && !invitationToken && !forgotMode && !resetToken && (
              <div>
                <label htmlFor="organizationName" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Çalışma Alanı (Şirket Adı)
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                    <Building2 className="h-4 w-4" />
                  </div>
                  <input
                    id="organizationName"
                    type="text"
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    className="block w-full pl-9 pr-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 text-xs text-slate-100 placeholder-slate-500 transition-colors"
                    placeholder="Şirket veya ekip adı"
                  />
                </div>
              </div>
            )}

            {!resetToken && <div>
              <label htmlFor="email" className="block text-xs font-medium text-slate-300 mb-1.5">
                Kurumsal E-posta
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Mail className="h-4 w-4" />
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
                  className="block w-full pl-9 pr-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 text-xs text-slate-100 placeholder-slate-500 transition-colors"
                  placeholder="isim@sirket.com"
                />
              </div>
            </div>}

            {!forgotMode && <div>
              <label htmlFor="password" className="block text-xs font-medium text-slate-300 mb-1.5">
                {resetToken ? 'Yeni Şifre' : 'Şifre'}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Lock className="h-4 w-4" />
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
                  className="block w-full pl-9 pr-3 py-2.5 bg-slate-900 border border-slate-700 rounded-lg focus:outline-none focus:border-blue-500 text-xs text-slate-100 placeholder-slate-500 transition-colors"
                  placeholder="••••••••"
                />
              </div>
            </div>}

            <div className="pt-2">
              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex justify-center items-center gap-2 py-2.5 px-4 border border-blue-600 rounded-lg shadow-sm text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    İşlem Yapılıyor...
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {resetToken ? 'Şifreyi Yenile' : forgotMode ? 'Yenileme Bağlantısı Gönder' : isRegister ? 'Kayıt Ol' : 'Giriş Yap'}
                    <LogIn className="w-4 h-4" />
                  </div>
                )}
              </button>
            </div>
          </form>

          {/* Mode Switcher */}
          <div className="mt-5 text-center">
            {!isRegister && !forgotMode && !resetToken && <button
              onClick={() => { setForgotMode(true); setErrorMsg(''); setSuccessMsg(''); setPassword(''); }}
              type="button"
              className="mb-3 block w-full text-xs font-medium text-slate-400 hover:text-slate-200 transition-colors"
            >
              Şifremi unuttum
            </button>}
            {forgotMode && <button
              onClick={() => { setForgotMode(false); setErrorMsg(''); setSuccessMsg(''); }}
              type="button"
              className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
            >
              Giriş ekranına dön
            </button>}
            {!forgotMode && !resetToken && (registrationEnabled ? <button
                onClick={() => {
                  setIsRegister(!isRegister);
                  setErrorMsg('');
                  setSuccessMsg('');
                  setPassword('');
                }}
                type="button"
              className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
            >
              {isRegister ? 'Zaten hesabınız var mı? Giriş yapın' : invitationToken ? 'Davet ile yeni hesap oluşturun' : 'Hesabınız yok mu? Kayıt olun'}
            </button> : <p className="text-xs text-slate-500">Yeni hesap kaydı yönetici tarafından kapatılmıştır.</p>)}
          </div>

          {showApkDownload && <div className="mt-5 border-t border-slate-800 pt-4">
            <a
              href={getApkDownloadUrl()}
              download
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
            >
              Android APK İndir
              <Download className="h-3.5 w-3.5" />
            </a>
          </div>}
        </div>
      </div>
    </div>
  );
}
