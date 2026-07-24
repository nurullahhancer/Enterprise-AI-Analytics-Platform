import { claimDueConnections } from '../../lib/connectorSyncDb';
import logger from '../../lib/logger';
import { synchronizeConnector } from './sync';

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let activePoll: Promise<void> | null = null;
let activeController: AbortController | null = null;

function boundedPollMs(): number {
  const parsed = Number(process.env.CONNECTOR_SCHEDULER_POLL_MS);
  return Number.isFinite(parsed) && Number.isInteger(parsed)
    ? Math.max(15_000, Math.min(parsed, 15 * 60_000))
    : 60_000;
}

async function pollDueConnections(signal: AbortSignal): Promise<void> {
  try {
    const due = await claimDueConnections(10);
    for (const connection of due) {
      if (signal.aborted) break;
      try {
        await synchronizeConnector({
          organizationId: connection.organization_id,
          connectionId: connection.id,
          actorEmail: connection.email,
          trigger: 'scheduled',
          ipAddress: 'scheduler',
          signal
        });
      } catch (error) {
        if (signal.aborted) break;
        logger.warn('Zamanlanmış konnektör eşitlemesi başarısız.', {
          connectionId: connection.id,
          organizationId: connection.organization_id,
          code: error instanceof Error && 'code' in error ? String(error.code) : 'CONNECTOR_SYNC_FAILED'
        });
      }
    }
  } catch (error) {
    if (!signal.aborted) logger.error('Konnektör zamanlayıcısı çalıştırılamadı.', { error });
  }
}

function triggerPoll(): Promise<void> {
  if (activePoll) return activePoll;
  activeController = new AbortController();
  const controller = activeController;
  activePoll = pollDueConnections(controller.signal).finally(() => {
    if (activeController === controller) activeController = null;
    activePoll = null;
  });
  return activePoll;
}

export function startConnectorScheduler(): void {
  if (timer || initialTimer || process.env.CONNECTOR_SCHEDULER_ENABLED === 'false') return;
  const pollMs = boundedPollMs();
  timer = setInterval(() => void triggerPoll(), pollMs);
  timer.unref();
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void triggerPoll();
  }, Math.min(10_000, pollMs));
  initialTimer.unref();
  logger.info('Veri konnektörü zamanlayıcısı etkin.', { pollMs });
}

export async function stopConnectorScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
  activeController?.abort();
  if (activePoll) await activePoll;
}

export const runConnectorSchedulerNow = triggerPoll;
