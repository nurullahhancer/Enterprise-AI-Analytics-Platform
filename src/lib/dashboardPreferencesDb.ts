import { database } from './database';
import { databaseReady, resolveOrganizationScope } from './db';

const WIDGET_IDS = new Set(['kpi-revenue', 'kpi-risk', 'trend', 'top-n', 'profile']);

export interface DashboardPreference {
  order: string[];
  hidden: string[];
  updatedAt: string | null;
}

function widgetIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && WIDGET_IDS.has(item)))];
}

export function validateDashboardPreference(input: unknown): { order: string[]; hidden: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dashboard tercihi geçersiz.');
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.order) || !Array.isArray(value.hidden)) throw new Error('Dashboard sıralaması liste olmalıdır.');
  return { order: widgetIds(value.order), hidden: widgetIds(value.hidden) };
}

export async function getDashboardPreference(scope: string, email: string): Promise<DashboardPreference> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  const row = await database.tenantTransaction(organizationId, (transaction) => transaction.get<{
    widget_order_json: string; hidden_widgets_json: string; updated_at: string;
  }>('SELECT widget_order_json, hidden_widgets_json, updated_at FROM dashboard_preferences WHERE organization_id = ? AND email = ?', [organizationId, email]));
  if (!row) return { order: [], hidden: [], updatedAt: null };
  let order: unknown = [];
  let hidden: unknown = [];
  try { order = JSON.parse(row.widget_order_json); } catch { /* use empty */ }
  try { hidden = JSON.parse(row.hidden_widgets_json); } catch { /* use empty */ }
  return { order: widgetIds(order), hidden: widgetIds(hidden), updatedAt: row.updated_at };
}

export async function saveDashboardPreference(scope: string, email: string, input: unknown): Promise<DashboardPreference> {
  await databaseReady;
  const organizationId = await resolveOrganizationScope(scope);
  const preference = validateDashboardPreference(input);
  await database.tenantTransaction(organizationId, (transaction) => transaction.run(
    `INSERT INTO dashboard_preferences (organization_id, email, widget_order_json, hidden_widgets_json, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (organization_id, email) DO UPDATE SET
       widget_order_json = excluded.widget_order_json,
       hidden_widgets_json = excluded.hidden_widgets_json,
       updated_at = CURRENT_TIMESTAMP`,
    [organizationId, email, JSON.stringify(preference.order), JSON.stringify(preference.hidden)]
  ));
  return getDashboardPreference(organizationId, email);
}
