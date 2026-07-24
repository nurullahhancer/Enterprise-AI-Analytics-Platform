import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../lib/utils';

const components: Components = {
  h1: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-black first:mt-0">{children}</h2>,
  h2: ({ children }) => <h3 className="mb-2 mt-4 text-base font-black first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1.5 mt-3 font-bold first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 leading-7 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-black text-inherit">{children}</strong>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-1 leading-7">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-3 border-l-4 border-current/25 pl-3 italic opacity-80">{children}</blockquote>,
  table: ({ children }) => (
    <div className="my-4 w-full overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-black/20">
      <table className="w-full min-w-[520px] border-collapse text-left text-xs md:text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-white/80">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-slate-200 dark:divide-white/10">{children}</tbody>,
  tr: ({ children }) => <tr className="even:bg-slate-50/80 dark:even:bg-white/[0.03]">{children}</tr>,
  th: ({ children }) => <th className="whitespace-nowrap border-r border-slate-200 px-3 py-2.5 font-black last:border-r-0 dark:border-white/10">{children}</th>,
  td: ({ children }) => <td className="border-r border-slate-100 px-3 py-2.5 align-top leading-5 last:border-r-0 dark:border-white/5">{children}</td>,
  pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-xl bg-slate-950 p-3 text-xs leading-5 text-slate-100">{children}</pre>,
  code: ({ className, children }) => className
    ? <code className={className}>{children}</code>
    : <code className="rounded bg-slate-200/80 px-1.5 py-0.5 text-[0.9em] dark:bg-white/10">{children}</code>,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">{children}</a>,
  hr: () => <hr className="my-4 border-slate-200 dark:border-white/10" />,
};

export default function MarkdownContent({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn('min-w-0 break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
    </div>
  );
}
