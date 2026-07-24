export type ViewState = 'dashboard' | 'decisions' | 'import' | 'chat' | 'settings' | 'enterprise' | 'team' | 'billing';

export interface OrganizationMembership {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  plan_key: 'starter' | 'professional' | 'enterprise';
  email: string;
  role: 'admin' | 'analyst' | 'viewer';
  status: 'active' | 'suspended';
}

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
