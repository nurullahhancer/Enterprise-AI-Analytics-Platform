import React, { useEffect, useState } from 'react';
import { LogIn, Lock, Mail, User as UserIcon } from 'lucide-react';
import { User } from '../types';
import { getApiUrl, jsonHeaders } from '../lib/api';

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

  useEffect(() => {
    fetch(getApiUrl('/api/config'))
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((config) => setRegistrationEnabled(config.registrationEnabled === true))
      .catch(() => setRegistrationEnabled(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    
    const userEmail = email.trim().toLowerCase();
    const userName = name.trim();
    
    try {
      if (isRegister) {
        const response = await fetch(getApiUrl('/api/register'), {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ email: userEmail, name: userName, password }),
        });
        const data = await response.json();

        if (response.ok) {
          setSuccessMsg(data.message || 'Kayıt başarılı! Şimdi giriş yapabilirsiniz.');
          setIsRegister(false);
          setName('');
          setPassword('');
        } else {
          setErrorMsg(data.error?.message || 'Kayıt sırasında bir hata oluştu.');
        }
      } else {
        const response = await fetch(getApiUrl('/api/login'), {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ email: userEmail, password }),
        });
        const data = await response.json();
        
        if (response.ok && data.token && data.user) {
          localStorage.setItem('reai_token', data.token);
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
    <div className="min-h-screen bg-[#0E0E0E] text-[#F0F0F0] font-sans flex flex-col justify-center px-6 sm:px-6 lg:px-8 overflow-hidden">
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

      <div className="mt-8 md:mt-12 mx-auto w-full max-w-sm">
        <div className="bg-white/5 py-8 px-5 sm:px-8 rounded-3xl border border-white/10 backdrop-blur-md">
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

          <form className="space-y-6" onSubmit={handleSubmit}>
            {isRegister && (
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

            <div>
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
                    autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="block w-full pl-12 pr-4 py-4 bg-black/50 border border-white/10 rounded-xl focus:ring-1 focus:ring-[#FFD700] focus:border-[#FFD700] text-sm transition-all text-[#F0F0F0] placeholder-white/20"
                  placeholder="isim@sirket.com"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-[10px] font-bold uppercase tracking-widest text-[#F0F0F0] opacity-60 mb-2">
                Şifre
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Lock className="h-5 w-5 opacity-40" />
                </div>
                <input
                  id="password"
                    name="password"
                    type="password"
                    autoComplete={isRegister ? 'new-password' : 'current-password'}
                    minLength={isRegister ? 12 : undefined}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-12 pr-4 py-4 bg-black/50 border border-white/10 rounded-xl focus:ring-1 focus:ring-[#FFD700] focus:border-[#FFD700] text-sm transition-all text-[#F0F0F0] placeholder-white/20"
                  placeholder="••••••••"
                />
              </div>
            </div>

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
                    {isRegister ? 'Kayıt Ol' : 'Giriş Yap'}
                    <LogIn className="w-5 h-5" />
                  </div>
                )}
              </button>
            </div>
          </form>

          {/* Mode Switcher */}
          <div className="mt-6 text-center">
            {registrationEnabled ? <button
                onClick={() => {
                  setIsRegister(!isRegister);
                  setErrorMsg('');
                  setSuccessMsg('');
                  setPassword('');
                }}
                type="button"
              className="text-xs font-bold uppercase tracking-widest text-[#FFD700] hover:text-[#FFD700]/80 transition-colors"
            >
              {isRegister ? 'Zaten hesabınız var mı? Giriş Yapın' : 'Hesabınız yok mu? Kayıt Olun'}
            </button> : <p className="text-[10px] font-bold uppercase tracking-widest text-white/35">Yeni hesap kaydı yönetici tarafından kapalıdır.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
