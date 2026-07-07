import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, User as UserIcon, Sparkles } from 'lucide-react';
import { ChatMessage } from '../types';
import { cn } from '../lib/utils';
import { authHeaders, getApiUrl, jsonHeaders } from '../lib/api';

export default function AIChat({ 
  messages, 
  setMessages 
}: { 
  messages: ChatMessage[], 
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>> 
}) {
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [chatMode, setChatMode] = useState<'dataset' | 'rag'>('dataset');
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
    if (!textToSend.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: textToSend.trim(),
      timestamp: new Date()
    };

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
        body: JSON.stringify({ message: userMsg.content, mode: chatMode })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || data.error || 'Gemini yanıtı alınamadı.');
      }
      
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.response || 'Yanıt alınamadı.',
        timestamp: new Date()
      };

      setMessages(prev => [...prev, assistantMsg]);
    } catch (error) {
      console.error('AIChat request failed', error);
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: error instanceof Error ? error.message : "Üzgünüm, şu anda sunucuya bağlanılamıyor. Lütfen daha sonra tekrar deneyin.",
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSend(input);
  };

  const quickPrompts = [
    "Veri setimi özetle ve analiz et",
    "Aykırı değerleri (anomali) bul ve listele",
    "Gelecek dönem satış tahmini nedir?"
  ];

  return (
    <div className={cn(
      "flex flex-col h-full overflow-hidden transition-colors duration-300",
      isDark ? "bg-[#111111]" : "bg-slate-50"
    )}>
      {/* Header - compact on mobile */}
      <div className={cn(
        "border-b px-4 md:px-8 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-sm z-10 shrink-0",
        isDark ? "bg-[#0E0E0E] border-white/10" : "bg-white border-slate-200"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-9 h-9 rounded-full flex items-center justify-center shrink-0",
            isDark ? "bg-[#FFD700] text-black" : "bg-[#4F46E5] text-white"
          )}>
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800 dark:text-white uppercase tracking-tight">Akıllı Yapay Zeka Asistanı</h2>
            <p className="text-[10px] text-slate-400 dark:text-white/40 font-mono uppercase tracking-widest hidden md:block">
              Veri setiniz veya doküman havuzunuzla ilgili doğal dilde analiz yapın
            </p>
          </div>
        </div>

        {/* RAG vs Dataset Mode Toggle */}
        <div className={cn(
          "flex items-center gap-1 p-1 rounded-xl border text-xs shrink-0 self-start sm:self-auto",
          isDark ? "bg-white/5 border-white/10" : "bg-slate-50 border-slate-200"
        )}>
          <button
            onClick={() => setChatMode('dataset')}
            className={cn(
              "px-3 py-1.5 rounded-lg font-bold uppercase tracking-wider transition-all",
              chatMode === 'dataset'
                ? (isDark ? "bg-[#FFD700] text-black shadow-sm" : "bg-[#4F46E5] text-white shadow-sm")
                : "opacity-60 hover:opacity-100"
            )}
          >
            Veri Kümesi
          </button>
          <button
            onClick={() => setChatMode('rag')}
            className={cn(
              "px-3 py-1.5 rounded-lg font-bold uppercase tracking-wider transition-all",
              chatMode === 'rag'
                ? (isDark ? "bg-[#FFD700] text-black shadow-sm" : "bg-[#4F46E5] text-white shadow-sm")
                : "opacity-60 hover:opacity-100"
            )}
          >
            Doküman Havuzu (RAG)
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6">
        {/* Onboarding quick prompts if only initial message exists */}
        {messages.length <= 1 && (
          <div className="max-w-xl mx-auto text-center py-6">
            <p className="text-xs text-slate-400 dark:text-white/30 uppercase tracking-widest font-bold mb-4">
              HIZLI ANALİZ ŞABLONLARI
            </p>
            <div className="flex flex-col gap-2">
              {quickPrompts.map((prompt) => (
                <button
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
            <div className="flex flex-col max-w-[85%] md:max-w-[75%]">
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
                "px-4 py-3 rounded-2xl text-[14px] md:text-base leading-relaxed shadow-sm",
                msg.role === 'user' 
                  ? (isDark 
                      ? "bg-[#FFD700] text-black rounded-tr-sm font-semibold" 
                      : "bg-[#4F46E5] text-white rounded-tr-sm font-semibold") 
                  : (isDark 
                      ? "bg-white/5 border border-white/5 rounded-tl-sm text-[#F0F0F0]" 
                      : "bg-white border border-slate-200/80 rounded-tl-sm text-slate-800")
              )}>
                {msg.content}
              </div>
            </div>
          </div>
        ))}

        {isLoading && (
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
        <form 
          onSubmit={handleFormSubmit}
          className="max-w-4xl mx-auto relative flex items-center gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Veriniz hakkında bir soru sorun (örn. En yüksek ciro yapan 3 bayiyi göster)..."
            className={cn(
              "w-full pl-4 md:pl-6 pr-4 py-3 bg-slate-50 border rounded-full focus:outline-none focus:ring-1 focus:border-transparent transition-all shadow-inner text-sm font-medium",
              isDark 
                ? "bg-black border-white/10 text-white focus:ring-[#FFD700] placeholder-white/30" 
                : "bg-slate-50 border-slate-200 text-slate-800 focus:ring-[#4F46E5] placeholder-slate-400"
            )}
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
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
