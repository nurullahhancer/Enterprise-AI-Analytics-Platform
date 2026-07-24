import { applyDataRetentionPolicy, listEnabledRetentionOrganizations } from '../../lib/governanceDb';
import logger from '../../lib/logger';

let timer: NodeJS.Timeout | null = null;
let active: Promise<void> | null = null;

async function run(): Promise<void> {
  if (active) return active;
  active = (async () => {
    const organizations = await listEnabledRetentionOrganizations();
    for (const organizationId of organizations) {
      try {
        const deleted = await applyDataRetentionPolicy(organizationId);
        if (Object.values(deleted).some((count) => count > 0)) logger.info('Veri saklama politikası uygulandı.', { organizationId, deleted });
      } catch (error) {
        logger.error('Veri saklama politikası uygulanamadı.', { organizationId, error });
      }
    }
  })().finally(() => { active = null; });
  return active;
}

export function startRetentionScheduler(): void {
  if (timer || process.env.DATA_RETENTION_SCHEDULER_ENABLED === 'false') return;
  timer = setInterval(() => void run(), 24 * 60 * 60_000);
  timer.unref();
  const initial = setTimeout(() => void run(), 30_000);
  initial.unref();
  logger.info('Veri saklama zamanlayıcısı etkin.', { intervalHours: 24 });
}

export async function stopRetentionScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (active) await active;
}

export const runRetentionSchedulerNow = run;
