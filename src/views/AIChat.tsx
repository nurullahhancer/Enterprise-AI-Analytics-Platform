import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User as UserIcon, Sparkles, AlertTriangle, CreditCard, History, Plus, Trash2, X, MessageSquare, Clock } from 'lucide-react';
import { ChatMessage } from '../types';
import { cn } from '../lib/utils';
import { apiFetch, authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import MarkdownContent from '../components/MarkdownContent';

interface QuotaDetails { resetAt?: string; used?: number; limit?: number; scope?: string }
class ChatRequestError extends Error {
  constructor(message: string, readonly code: string, readonly details?: QuotaDetails) { super(message); }
}

interface ChatSessionItem {
  id: string;
  organizationId: string;
  email: string;
  title: string;
  mode: 'dataset' | 'rag';
  createdAt: string;
  updatedAt: string;
}

export default function AIChat({ 
  messages, 
  setMessages,
  onOpenBilling,
  canManageBilling = false,
}: { 
  messages: ChatMessage[], 
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  onOpenBilling?: () => void,
  canManageBilling?: boolean,
}) {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [chatMode, setChatMode] = useState<'dataset' | 'rag'>('dataset');
  const [quotaError, setQuotaError] = useState<{ message: string; code: string; details?: QuotaDetails } | null>(null);
  
  // Chat Session & History States
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<ChatSessionItem[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // Theme check helper
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    setIsDark(document.documentElement.classList.contains('dark'));
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load chat sessions from API
  const fetchSessions = async () => {
    setIsLoadingSessions(true);
    try {
      const res = await apiFetch(getApiUrl('/api/chat/sessions'), {
        headers: authHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.sessions)) {
          setSessions(data.sessions);
        }
      }
    } catch (err) {
      console.error('Failed to load chat sessions:', err);
    } finally {
      setIsLoadingSessions(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  // Select a past session and load its messages
  const handleSelectSession = async (sessionId: string) => {
    try {
      const res = await apiFetch(getApiUrl(`/api/chat/sessions/${sessionId}`), {
        headers: authHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        if (data.session && Array.isArray(data.messages)) {
          setActiveSessionId(data.session.id);
          setChatMode(data.session.mode || 'dataset');
          const loadedMsgs: ChatMessage[] = data.messages.map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date(m.createdAt)
          }));
          setMessages(loadedMsgs);
          setIsHistoryOpen(false);
        }
      }
    } catch (err) {
      console.error('Failed to load session details:', err);
    }
  };

  // Start a new fresh chat session
  const handleNewChat = () => {
    setActiveSessionId(null);
    setMessages([
      {
        id: '1',
        role: 'assistant',
        content: 'Merhaba! Veri setiniz veya yüklediğiniz belgeler hakkında merak ettiğiniz tüm soruları yanıtlayabilir, trend ve analizleri detaylandırabilirim. Nasıl yardımcı olabilirim?',
        timestamp: new Date()
      }
    ]);
    setIsHistoryOpen(false);
  };

  // Delete a past session
  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await apiFetch(getApiUrl(`/api/chat/sessions/${sessionId}`), {
        method: 'DELETE',
        headers: authHeaders()
      });
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.id !== sessionId));
        if (activeSessionId === sessionId) {
          handleNewChat();
        }
      }
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  };

  const handleSend = async (textToSend: string) => {
    if (!textToSend.trim() || isLoading || quotaError) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: textToSend.trim(),
      timestamp: new Date()
    };
    const history = messages
      .filter((message) => message.id !== '1')
      .slice(-10)
      .map((message) => ({ role: message.role, content: message.content }));

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await apiFetch(getApiUrl('/api/chat'), {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          ...authHeaders()
        },
        body: JSON.stringify({
          message: userMsg.content,
          mode: chatMode,
          stream: true,
          history,
          sessionId: activeSessionId
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ChatRequestError(data.error?.message || data.error || 'AI yanıtı alınamadı.', data.error?.code || 'AI_REQUEST_FAILED', data.error?.details);
      }

      if (!res.body) {
        throw new Error('Yanıt akışı alınamadı.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let hasAddedAssistantMsg = false;
      const assistantMsgId = (Date.now() + 1).toString();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data:')) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;
            let parsed: { token?: string; sessionId?: string; error?: string };
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.sessionId && !activeSessionId) {
              setActiveSessionId(parsed.sessionId);
              fetchSessions();
            }
            if (parsed.token) {
              if (!hasAddedAssistantMsg) {
                setMessages(prev => [...prev, {
                  id: assistantMsgId,
                  role: 'assistant',
                  content: parsed.token!,
                  timestamp: new Date()
                }]);
                hasAddedAssistantMsg = true;
              } else {
                setMessages(prev => prev.map(msg =>
                  msg.id === assistantMsgId
                    ? { ...msg, content: msg.content + parsed.token }
                    : msg
                ));
              }
            }
          }
        }
      }
      if (!hasAddedAssistantMsg) throw new Error('AI servisi boş yanıt döndürdü.');
      fetchSessions();
    } catch (error) {
      console.error('AIChat request failed', error);
      if (error instanceof ChatRequestError && (error.code === 'AI_QUOTA_EXHAUSTED' || error.code === 'AI_USER_QUOTA_EXHAUSTED')) {
        setQuotaError({ message: error.message, code: error.code, details: error.details });
        return;
      }
      setMessages(prev => {
        const hasPlaceholder = prev.some(msg => msg.id && msg.role === 'assistant' && !msg.content);
        if (hasPlaceholder) {
          return prev.map(msg =>
            msg.role === 'assistant' && !msg.content
              ? { ...msg, content: error instanceof Error ? error.message : "Üzgünüm, şu anda sunucuya bağlanılamıyor. Lütfen daha sonra tekrar deneyin." }
              : msg
          );
        } else {
          return [...prev, {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: error instanceof Error ? error.message : "Üzgünüm, şu anda sunucuya bağlanılamıyor. Lütfen daha sonra tekrar deneyin.",
            timestamp: new Date()
          }];
        }
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSend(input);
  };

  const quickPrompts = [
    "Verilerimdeki önemli sonuçları kısaca anlat",
    "Normalden farklı görünen kayıtlar var mı?",
    "Gelecek dönem kaç satış bekleniyor?"
  ];

  return (
    <div className="relative flex h-full min-h-[calc(100dvh-6rem)] md:min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-[#151E2E] transition-colors">
      {/* Header - with History Toggle */}
      <div className="z-10 flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-3 py-3 shadow-xs dark:border-slate-800 dark:bg-[#111827] md:px-6 md:py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-xs">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 md:text-base">Veri & Analiz Asistanı</h2>
            <p className="hidden text-xs text-slate-500 dark:text-slate-400 md:block">
              Verileriniz veya yüklediğiniz belgeler hakkında soru sorun
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* New Chat Button */}
          <button
            type="button"
            onClick={handleNewChat}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-xs hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 transition-colors"
            title="Yeni Sohbet Başlat"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Yeni Sohbet</span>
          </button>

          {/* History Drawer Toggle Button */}
          <button
            type="button"
            onClick={() => {
              fetchSessions();
              setIsHistoryOpen(true);
            }}
            className="relative flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-xs hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800 transition-colors"
            title="Geçmiş Sohbetler"
          >
            <History className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            <span>Geçmiş</span>
            {sessions.length > 0 && (
              <span className="ml-0.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-blue-100 px-1 text-[10px] font-bold text-blue-600 dark:bg-blue-900/60 dark:text-blue-300">
                {sessions.length}
              </span>
            )}
          </button>

          {/* RAG vs Dataset Mode Toggle */}
          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs dark:border-slate-800 dark:bg-slate-900">
            <button
              type="button"
              onClick={() => setChatMode('dataset')}
              aria-pressed={chatMode === 'dataset'}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-semibold transition-all",
                chatMode === 'dataset'
                  ? "bg-blue-600 text-white shadow-xs"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              )}
            >
              Verilerim
            </button>
            <button
              type="button"
              onClick={() => setChatMode('rag')}
              aria-pressed={chatMode === 'rag'}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-semibold transition-all",
                chatMode === 'rag'
                  ? "bg-blue-600 text-white shadow-xs"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
              )}
            >
              Belgelerim
            </button>
          </div>
        </div>
      </div>

      {/* Slide-Out History Drawer Overlay */}
      {isHistoryOpen && (
        <div className="absolute inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-xs transition-opacity duration-200">
          <div className="flex h-full w-80 max-w-[85vw] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-[#111827] sm:w-96">
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3.5 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">Sohbet Geçmişi</h3>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleNewChat}
                  className="flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 transition-colors"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Yeni
                </button>
                <button
                  type="button"
                  onClick={() => setIsHistoryOpen(false)}
                  className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Session List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {isLoadingSessions ? (
                <div className="flex h-32 items-center justify-center text-xs text-slate-500">
                  <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                  Giriş yapılmış sohbetler yükleniyor…
                </div>
              ) : sessions.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center p-4 text-center text-xs text-slate-500 dark:text-slate-400">
                  <MessageSquare className="mb-2 h-8 w-8 stroke-1 text-slate-400" />
                  <p className="font-semibold">Henüz geçmiş sohbetiniz yok</p>
                  <p className="mt-1 text-[11px] text-slate-400">Soracağınız tüm sorular buraya otomatik kaydedilir.</p>
                </div>
              ) : (
                sessions.map((session) => {
                  const isActive = session.id === activeSessionId;
                  const dateStr = new Date(session.updatedAt).toLocaleDateString('tr-TR', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit'
                  });
                  return (
                    <div
                      key={session.id}
                      onClick={() => handleSelectSession(session.id)}
                      className={cn(
                        "group relative flex cursor-pointer items-start justify-between rounded-lg border p-3 text-xs transition-all",
                        isActive
                          ? "border-blue-500 bg-blue-50/70 dark:border-blue-500/50 dark:bg-blue-950/30"
                          : "border-slate-200 bg-slate-50/60 hover:border-blue-300 hover:bg-white dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-slate-700 dark:hover:bg-slate-900"
                      )}
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className={cn(
                            "inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                            session.mode === 'rag'
                              ? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                              : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          )}>
                            {session.mode === 'rag' ? 'Belge' : 'Veri'}
                          </span>
                          <span className="flex items-center text-[10px] text-slate-400">
                            <Clock className="mr-0.5 h-3 w-3" />
                            {dateStr}
                          </span>
                        </div>
                        <p className="mt-1 font-medium text-slate-800 dark:text-slate-200 line-clamp-2 leading-relaxed">
                          {session.title || 'Sohbet'}
                        </p>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => handleDeleteSession(session.id, e)}
                        className="rounded p-1 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400 transition-all"
                        title="Sohbeti Sil"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-4 md:space-y-5 md:px-6 md:py-5">
        {/* Quick Prompts */}
        {messages.length <= 1 && (
          <div className="mx-auto max-w-lg py-4 text-center">
            <p className="mb-3 text-xs font-semibold text-slate-500 dark:text-slate-400">
              Örnek Sorular
            </p>
            <div className="flex flex-col gap-2">
              {quickPrompts.map((prompt) => (
                <button
                  type="button"
                  key={prompt}
                  onClick={() => handleSend(prompt)}
                  disabled={isLoading}
                  className="interactive-card rounded-lg border border-slate-200 bg-slate-50/60 px-3.5 py-2.5 text-left text-xs font-medium text-slate-700 transition-colors hover:border-blue-300 hover:bg-white hover:text-blue-600 disabled:opacity-50 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-blue-500/40 dark:hover:bg-slate-900 dark:hover:text-blue-400"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div 
            key={msg.id} 
            className={cn(
              "mx-auto flex w-full max-w-3xl gap-2.5 md:gap-3.5",
              msg.role === 'user' ? "flex-row-reverse" : "flex-row"
            )}
          >
            {/* Avatar */}
            <div className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs shadow-xs",
              msg.role === 'user' 
                ? "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" 
                : "border-blue-600 bg-blue-600 text-white"
            )}>
              {msg.role === 'user' ? <UserIcon className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
            </div>
            
            {/* Bubble */}
            <div className={cn(
              "flex min-w-0 flex-col",
              msg.role === 'assistant' ? "max-w-[88%] md:max-w-[80%]" : "max-w-[85%] md:max-w-[75%]"
            )}>
              <div className={cn(
                "mb-1 flex items-center gap-2",
                msg.role === 'user' && "justify-end"
              )}>
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  {msg.role === 'user' ? 'Siz' : 'ReAI Asistanı'}
                </span>
                <span className="text-[10px] text-slate-400 dark:text-slate-500">
                  {msg.timestamp.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                </span>
              </div>
              <div 
                style={msg.role === 'user' ? { color: '#ffffff' } : { color: isDark ? '#f8fafc' : '#09090b' }}
                className={cn(
                  "min-w-0 rounded-xl px-4 py-3 text-xs leading-relaxed shadow-xs md:text-sm font-semibold",
                  msg.role === 'user' && "whitespace-pre-wrap",
                  msg.role === 'user' 
                    ? "rounded-tr-xs bg-blue-600 !text-white shadow-sm" 
                    : "rounded-tl-xs border border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-100"
                )}
              >
                {msg.role === 'assistant' ? <MarkdownContent content={msg.content} /> : msg.content}
              </div>
            </div>
          </div>
        ))}

        {isLoading && (messages.length === 0 || messages[messages.length - 1].role !== 'assistant') && (
          <div className="mx-auto flex w-full max-w-3xl gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-xs">
              <Bot className="h-4 w-4" />
            </div>
            <div className="flex flex-col">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">ReAI Asistanı</span>
              </div>
              <div className="flex items-center gap-2.5 rounded-xl rounded-tl-xs border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-700 dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-300">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"></div>
                <span className="font-medium">Yanıt hazırlanıyor…</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <div className="sticky bottom-0 z-20 shrink-0 border-t border-slate-200 bg-white px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3 shadow-md dark:border-slate-800 dark:bg-[#111827] md:px-6 md:py-3.5">
        {quotaError && (
          <div className="mx-auto mb-3 flex max-w-3xl flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300 sm:flex-row sm:items-center">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1"><p className="font-bold">Yapay zekâ kullanım hakkı doldu</p><p className="mt-0.5 leading-4">{quotaError.message}</p></div>
            {canManageBilling && onOpenBilling ? <button type="button" onClick={onOpenBilling} className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md bg-amber-600 px-3 text-xs font-semibold text-white hover:bg-amber-700"><CreditCard className="h-3.5 w-3.5" /> Ayarlar</button> : <span className="font-semibold">Yöneticinizle iletişime geçin.</span>}
          </div>
        )}
        <form 
          onSubmit={handleFormSubmit}
          className="mx-auto flex max-w-3xl items-center gap-2"
        >
          <input
            type="text"
            aria-label="Yapay zeka asistanına mesaj"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Mesajınızı yazın..."
            style={{ color: isDark ? '#ffffff' : '#000000', backgroundColor: isDark ? '#0f172a' : '#ffffff', fontWeight: 600 }}
            className="w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-xs font-semibold !text-slate-950 placeholder:font-normal placeholder:text-slate-500 outline-none transition-colors focus:border-blue-500 focus:bg-white disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:!text-white dark:placeholder:text-slate-400 dark:focus:border-blue-500 md:text-sm"
            disabled={isLoading || Boolean(quotaError)}
          />
          <button
            type="submit"
            aria-label="Mesajı gönder"
            disabled={!input.trim() || isLoading || Boolean(quotaError)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-xs transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
