export type ViewState = 'dashboard' | 'import' | 'chat' | 'settings' | 'enterprise';

export interface User {
  id: string;
  name: string;
  email: string;
  tenantId?: string;
  role: 'admin' | 'analyst' | 'viewer';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface Dataset {
  id: string;
  name: string;
  rows: number;
  uploadedAt: Date;
}
