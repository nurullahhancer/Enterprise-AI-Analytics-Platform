import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User as UserIcon, Sparkles, AlertTriangle, CreditCard } from 'lucide-react';
import { ChatMessage } from '../types';
import { cn } from '../lib/utils';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';
import MarkdownContent from '../components/MarkdownContent';

interface QuotaDetails { resetAt?: string; used?: number; limit?: number; scope?: string }
class ChatRequestError extends Error {
  constructor(message: string, readonly code: string, readonly details?: QuotaDetails) { super(message); }
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
      .slice(-4)
      .map((message) => ({ role: message.role, content: message.content }));

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch(getApiUrl('/api/chat'), {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          ...authHeaders()
        },
        body: JSON.stringify({ message: userMsg.content, mode: chatMode, stream: true, history })
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
            let parsed: { token?: string; error?: string };
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }
            if (parsed.error) throw new Error(parsed.error);
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
    <div className={cn(
      "flex h-full min-h-0 flex-col overflow-hidden transition-colors duration-300",
      isDark ? "bg-[#111111]" : "bg-slate-50"
    )}>
      {/* Header - compact on mobile */}
      <div className={cn(
        "z-10 flex shrink-0 items-center justify-between gap-3 border-b px-3 py-3 shadow-sm md:px-8 md:py-4",
        isDark ? "bg-[#0E0E0E] border-white/10" : "bg-white border-slate-200"
      )}>
        <div className="hidden items-center gap-3 md:flex">
          <div className={cn(
            "w-9 h-9 rounded-full flex items-center justify-center shrink-0",
            isDark ? "bg-[#FFD700] text-black" : "bg-[#4F46E5] text-white"
          )}>
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800 dark:text-white uppercase tracking-tight">Veri Asistanı</h2>
            <p className="text-[10px] text-slate-400 dark:text-white/40 font-mono uppercase tracking-widest hidden md:block">
              Verileriniz veya belgeleriniz hakkında normal bir cümleyle soru sorun
            </p>
          </div>
        </div>

        {/* RAG vs Dataset Mode Toggle */}
        <div className={cn(
          "flex w-full shrink-0 items-center gap-1 rounded-xl border p-1 text-xs md:w-auto",
          isDark ? "bg-white/5 border-white/10" : "bg-slate-50 border-slate-200"
        )}>
          <button
            type="button"
            onClick={() => setChatMode('dataset')}
            aria-pressed={chatMode === 'dataset'}
            className={cn(
              "min-h-10 flex-1 rounded-lg px-3 py-1.5 font-bold uppercase tracking-wider transition-all md:flex-none",
              chatMode === 'dataset'
                ? (isDark ? "bg-[#FFD700] text-black shadow-sm" : "bg-[#4F46E5] text-white shadow-sm")
                : "opacity-60 hover:opacity-100"
            )}
          >
            Verilerim
          </button>
          <button
            type="button"
            onClick={() => setChatMode('rag')}
            aria-pressed={chatMode === 'rag'}
            className={cn(
              "min-h-10 flex-1 rounded-lg px-3 py-1.5 font-bold uppercase tracking-wider transition-all md:flex-none",
              chatMode === 'rag'
                ? (isDark ? "bg-[#FFD700] text-black shadow-sm" : "bg-[#4F46E5] text-white shadow-sm")
                : "opacity-60 hover:opacity-100"
            )}
          >
            <span>Belgelerim</span>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-3 py-5 md:space-y-6 md:px-8 md:py-6">
        {/* Onboarding quick prompts if only initial message exists */}
        {messages.length <= 1 && (
          <div className="max-w-xl mx-auto text-center py-6">
            <p className="text-xs text-slate-400 dark:text-white/30 uppercase tracking-widest font-bold mb-4">
              ÖRNEK SORULAR
            </p>
            <div className="flex flex-col gap-2">
              {quickPrompts.map((prompt) => (
                <button
                  type="button"
                  key={prompt}
                  onClick={() => handleSend(prompt)}
                  disabled={isLoading}
                  className={cn(
                    "text-xs font-bold text-left px-4 py-3 rounded-xl border transition-all duration-200 active:scale-98 disabled:opacity-50",
                    isDark 
                      ? "bg-white/5 border-white/10 text-white/80 hover:bg-white/10 hover:text-white" 
                      : "bg-white border-slate-200 text-slate-700 hover:bg-slate-100/50 hover:text-[#4F46E5]"
                  )}
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
              "flex gap-3 md:gap-4 max-w-4xl mx-auto w-full",
              msg.role === 'user' ? "flex-row-reverse" : "flex-row"
            )}
          >
            {/* Avatar */}
            <div className={cn(
              "w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm border",
              msg.role === 'user' 
                ? "bg-slate-100 dark:bg-white/10 border-slate-200 dark:border-white/20 text-slate-600 dark:text-white" 
                : (isDark 
                    ? "bg-gradient-to-tr from-pink-500 to-yellow-500 border-white/10 text-white" 
                    : "bg-[#4F46E5] border-[#4F46E5] text-white")
            )}>
              {msg.role === 'user' ? <UserIcon className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
            </div>
            
            {/* Bubble */}
            <div className={cn(
              "flex min-w-0 flex-col",
              msg.role === 'assistant' ? "max-w-[calc(100%-3rem)] md:max-w-[85%]" : "max-w-[85%] md:max-w-[75%]"
            )}>
              <div className={cn(
                "flex items-center gap-2 mb-1",
                msg.role === 'user' && "justify-end"
              )}>
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-white/40">
                  {msg.role === 'user' ? 'Kullanıcı' : 'ReAi Asistanı'}
                </span>
                <span className="text-[9px] text-slate-300 dark:text-white/20 font-mono">
                  {msg.timestamp.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                </span>
              </div>
              <div className={cn(
                "min-w-0 px-4 py-3 rounded-2xl text-[14px] md:text-base leading-relaxed shadow-sm",
                msg.role === 'user' && "whitespace-pre-wrap",
                msg.role === 'user' 
                  ? (isDark 
                      ? "bg-[#FFD700] text-black rounded-tr-sm font-semibold" 
                      : "bg-[#4F46E5] text-white rounded-tr-sm font-semibold") 
                  : (isDark 
                      ? "bg-white/5 border border-white/5 rounded-tl-sm text-[#F0F0F0]" 
                      : "bg-white border border-slate-200/80 rounded-tl-sm text-slate-800")
              )}>
                {msg.role === 'assistant' ? <MarkdownContent content={msg.content} /> : msg.content}
              </div>
            </div>
          </div>
        ))}

        {isLoading && (messages.length === 0 || messages[messages.length - 1].role !== 'assistant') && (
          <div className="flex gap-3 md:gap-4 max-w-4xl mx-auto w-full">
            <div className={cn(
              "w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm border",
              isDark 
                ? "bg-gradient-to-tr from-pink-500 to-yellow-500 border-white/10 text-white" 
                : "bg-[#4F46E5] border-[#4F46E5] text-white"
            )}>
              <Bot className="w-4 h-4" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 dark:text-white/40">ReAi Asistanı</span>
              </div>
              <div className={cn(
                "px-4 py-3 rounded-2xl rounded-tl-sm flex items-center gap-3 shadow-sm border",
                isDark ? "bg-white/5 border-white/5 text-[#F0F0F0]" : "bg-white border-slate-200 text-slate-800"
              )}>
                <div className={cn(
                  "w-3.5 h-3.5 border-2 border-t-transparent rounded-full animate-spin",
                  isDark ? "border-white/30 border-t-[#FFD700]" : "border-[#4F46E5]/30 border-t-[#4F46E5]"
                )}></div>
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-white/50">Düşünüyor...</span>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <div className={cn(
        "border-t px-3 md:px-6 py-3.5 shrink-0",
        isDark ? "bg-[#0E0E0E] border-white/10" : "bg-white border-slate-200"
      )}>
        {quotaError && (
          <div className="mx-auto mb-3 flex max-w-4xl flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 sm:flex-row sm:items-center">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <div className="min-w-0 flex-1"><p className="text-sm font-bold">Yapay zekâ kullanım hakkı doldu</p><p className="mt-1 text-xs leading-5">{quotaError.message}{quotaError.details?.resetAt ? ` Haklar ${new Date(quotaError.details.resetAt).toLocaleDateString('tr-TR')} tarihinde yenilenir.` : ''}</p></div>
            {canManageBilling && onOpenBilling ? <button type="button" onClick={onOpenBilling} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 text-xs font-bold text-white hover:bg-amber-700"><CreditCard className="h-4 w-4" /> Ek Hak ve Ayarlar</button> : <span className="text-xs font-bold">Yöneticinizle iletişime geçin.</span>}
          </div>
        )}
        <form 
          onSubmit={handleFormSubmit}
          className="max-w-4xl mx-auto relative flex items-center gap-2"
        >
          <input
            type="text"
            aria-label="Yapay zeka asistanına mesaj"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Örneğin: Gelecek ay kaç satış bekleniyor?"
            className={cn(
              "w-full pl-4 md:pl-6 pr-4 py-3 bg-slate-50 border rounded-full focus:outline-none focus:ring-1 focus:border-transparent transition-all shadow-inner text-sm font-medium",
              isDark 
                ? "bg-black border-white/10 text-white focus:ring-[#FFD700] placeholder-white/30" 
                : "bg-slate-50 border-slate-200 text-slate-800 focus:ring-[#4F46E5] placeholder-slate-400"
            )}
            disabled={isLoading || Boolean(quotaError)}
          />
          <button
            type="submit"
            aria-label="Mesajı gönder"
            disabled={!input.trim() || isLoading || Boolean(quotaError)}
            className={cn(
              "w-11 h-11 rounded-full flex items-center justify-center shrink-0 active:scale-95 transition-transform disabled:opacity-50 disabled:cursor-not-allowed shadow-lg",
              isDark 
                ? "bg-[#FFD700] text-black" 
                : "bg-[#4F46E5] text-white"
            )}
          >
            <Send className="w-5 h-5 ml-0.5" />
          </button>
        </form>
      </div>
    </div>
  );
}
