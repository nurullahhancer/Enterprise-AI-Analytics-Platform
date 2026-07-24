import {
  addAuditLog,
  addNotification,
  listOrganizationAdminEmails,
  StorageQuotaError
} from '../../lib/db';
import {
  acquireConnectorSyncLease,
  finalizeConnectorSyncFailure,
  finalizeConnectorSyncSuccess,
  releaseConnectorSyncLease
} from '../../lib/connectorSyncDb';
import logger from '../../lib/logger';
import { decryptConnectorConfig } from '../../lib/secrets';
import { fetchPublicJson } from '../../lib/safeFetch';
import { jsonValueToCsv } from '../datasets/normalize';
import { evaluateKpisForOrganization } from '../kpis/service';
import { queryPostgresAsCsv } from './postgres';
import { deliverBusinessAlert } from '../../lib/notificationChannels';

export type ConnectorSyncTrigger = 'manual' | 'scheduled';

export interface ConnectorSyncResult {
  connectionId: number;
  connectionName: string;
  dataset: { id: number; filename: string; rowCount: number; columnCount: number };
  startedAt: string;
  finishedAt: string;
}

export class ConnectorSynchronizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ConnectorSynchronizationError';
  }
}

function synchronizationError(error: unknown): ConnectorSynchronizationError {
  if (error instanceof ConnectorSynchronizationError) return error;
  if (error instanceof StorageQuotaError) return new ConnectorSynchronizationError(error.code, error.message, 413);
  return new ConnectorSynchronizationError(
    'REST_INGEST_FAILED',
    'Veri kaynağı eşitlenirken beklenmeyen bir hata oluştu. Ayrıntılar sunucu kayıtlarına yazıldı.',
    502
  );
}

function publicSourceMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  return /^(Geçerli bir REST|REST |Bu REST|Özel ağ|JSON |JSON kaynağı|JSON kökü|Bir veri hücresi|Bu PostgreSQL|PostgreSQL |SQL |SQL konnektörü)/.test(message)
    ? message.slice(0, 500)
    : fallback;
}

async function secondaryEffects(tasks: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (failed > 0) logger.warn('Konnektör audit/bildirim yan etkisi tamamlanamadı.', { failed });
}

async function notifyOrganizationAdmins(
  organizationId: string,
  fallbackEmail: string,
  title: string,
  message: string
): Promise<void> {
  const admins = await listOrganizationAdminEmails(organizationId);
  const recipients = admins.length > 0 ? admins : [fallbackEmail];
  await Promise.all([...new Set(recipients)].map((email) => addNotification(organizationId, title, message, email)));
  const event = /yeniden|sağlıklı/i.test(title) ? 'connector_recovery' : 'connector_failure';
  await deliverBusinessAlert(organizationId, event, title, message);
}

export async function synchronizeConnector(options: {
  organizationId: string;
  connectionId: number;
  actorEmail: string;
  trigger: ConnectorSyncTrigger;
  ipAddress?: string;
  signal?: AbortSignal;
}): Promise<ConnectorSyncResult> {
  const { organizationId, connectionId, actorEmail, trigger } = options;
  const startedAt = new Date().toISOString();
  const lease = await acquireConnectorSyncLease(organizationId, connectionId);
  if (lease.status !== 'acquired') {
    if (lease.status === 'not_found') {
      throw new ConnectorSynchronizationError('NOT_FOUND', 'Bağlantı bulunamadı.', 404);
    }
    throw new ConnectorSynchronizationError(
      'CONNECTOR_SYNC_IN_PROGRESS',
      'Bu bağlantı için başka bir veri yenileme işlemi devam ediyor.',
      409
    );
  }
  const { connection, leaseId } = lease;
  if (!['api', 'postgresql'].includes(connection.type)) {
    await releaseConnectorSyncLease(organizationId, connectionId, leaseId);
    throw new ConnectorSynchronizationError('CONNECTOR_NOT_IMPLEMENTED', 'Bu konnektör tipi desteklenmiyor.', 501);
  }

  try {
    if (options.signal?.aborted) {
      throw new ConnectorSynchronizationError('CONNECTOR_SYNC_CANCELLED', 'Veri yenileme işlemi durduruldu.', 503);
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(decryptConnectorConfig(connection.config));
    } catch {
      throw new ConnectorSynchronizationError(
        'CONNECTOR_CONFIG_UNAVAILABLE',
        'Konnektör yapılandırması çözülemedi; bağlantıyı yeniden oluşturun.',
        503
      );
    }

    let normalized: ReturnType<typeof jsonValueToCsv>;
    if (connection.type === 'postgresql') {
      try {
        normalized = await queryPostgresAsCsv(config, options.signal);
      } catch (error) {
        if (options.signal?.aborted) throw new ConnectorSynchronizationError('CONNECTOR_SYNC_CANCELLED', 'Veri yenileme işlemi durduruldu.', 503);
        throw new ConnectorSynchronizationError('SQL_SOURCE_UNAVAILABLE', publicSourceMessage(error, 'PostgreSQL veri kaynağına güvenli bağlantı kurulamadı.'), 502);
      }
    } else {
      let json: unknown;
      try {
        json = await fetchPublicJson(String(config.url || ''), options.signal);
      } catch (error) {
        if (options.signal?.aborted) {
          throw new ConnectorSynchronizationError('CONNECTOR_SYNC_CANCELLED', 'Veri yenileme işlemi durduruldu.', 503);
        }
        throw new ConnectorSynchronizationError(
          'REST_SOURCE_UNAVAILABLE',
          publicSourceMessage(error, 'REST veri kaynağına güvenli bağlantı kurulamadı.'),
          502
        );
      }
      try {
        normalized = jsonValueToCsv(json);
      } catch (error) {
        throw new ConnectorSynchronizationError(
          'REST_DATA_INVALID',
          publicSourceMessage(error, 'REST kaynağındaki JSON verisi tabloya dönüştürülemedi.'),
          422
        );
      }
    }

    const filename = `${String(connection.name).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80)}_ingest.csv`;
    const finishedAt = new Date().toISOString();
    const state = await finalizeConnectorSyncSuccess(
      organizationId,
      connectionId,
      actorEmail,
      leaseId,
      {
        filename,
        content: normalized.csv,
        actorEmail,
        rowCount: normalized.rowCount,
        columnCount: normalized.columnCount,
        options: { sourceType: connection.type === 'postgresql' ? 'sql' : 'rest', sourceRef: `connection:${connectionId}`, replaceExistingSource: true }
      },
      {
        rowCount: normalized.rowCount,
        columnCount: normalized.columnCount,
        startedAt,
        finishedAt
      }
    );
    if (!state) {
      throw new ConnectorSynchronizationError(
        'CONNECTOR_SYNC_SUPERSEDED',
        'Bu yenileme daha güncel bir işlem tarafından geçersiz kılındı.',
        409
      );
    }

    await evaluateKpisForOrganization(organizationId, actorEmail, { ipAddress: options.ipAddress || trigger })
      .catch((error) => logger.warn('Veri eşitlemesi sonrası KPI değerlendirmesi tamamlanamadı.', {
        connectionId,
        organizationId,
        code: error instanceof Error && 'code' in error ? String(error.code) : 'KPI_EVALUATION_FAILED'
      }));

    const effects: Array<Promise<unknown>> = [
      addAuditLog(
        organizationId,
        trigger === 'scheduled' ? 'Scheduled Data Sync Completed' : 'Data Ingested',
        `${connection.type === 'postgresql' ? 'PostgreSQL' : 'REST'} konnektörü eşitlendi: ${connection.name} (${normalized.rowCount} satır, ${normalized.columnCount} kolon)`,
        options.ipAddress || trigger,
        actorEmail
      )
    ];
    if (trigger === 'manual') {
      effects.push(addNotification(
        organizationId,
        'Veri Eşitleme Tamamlandı',
        `"${connection.name}" konnektörünün güncel snapshot verisi yenilendi.`,
        actorEmail
      ));
    } else if (state.previousStatus === 'failure') {
      effects.push(notifyOrganizationAdmins(
        organizationId,
        actorEmail,
        'Veri Kaynağı Yeniden Sağlıklı',
        `"${connection.name}" otomatik eşitlemesi yeniden başarıyla tamamlandı.`
      ));
    }
    await secondaryEffects(effects);

    return {
      connectionId,
      connectionName: connection.name,
      dataset: { id: state.datasetId, filename, rowCount: normalized.rowCount, columnCount: normalized.columnCount },
      startedAt,
      finishedAt
    };
  } catch (rawError) {
    const error = synchronizationError(rawError);
    if (error.code === 'CONNECTOR_SYNC_CANCELLED') {
      await releaseConnectorSyncLease(organizationId, connectionId, leaseId).catch((releaseError) => {
        logger.warn('Durdurulan konnektörün kilidi bırakılamadı.', { connectionId, organizationId, error: releaseError });
      });
      throw error;
    }
    if (!(rawError instanceof ConnectorSynchronizationError) && !(rawError instanceof StorageQuotaError)) {
      logger.error('REST konnektöründe beklenmeyen eşitleme hatası.', { connectionId, organizationId, error: rawError });
    }

    const finishedAt = new Date().toISOString();
    const state = await finalizeConnectorSyncFailure(organizationId, connectionId, actorEmail, leaseId, {
      errorCode: error.code,
      errorMessage: error.message,
      startedAt,
      finishedAt
    }).catch((recordError) => {
      logger.error('Konnektör eşitleme hatası kaydedilemedi.', { connectionId, organizationId, error: recordError });
      return null;
    });

    if (state) {
      const effects: Array<Promise<unknown>> = [addAuditLog(
        organizationId,
        'Data Sync Failed',
        `${connection.type === 'postgresql' ? 'PostgreSQL' : 'REST'} konnektörü eşitlenemedi: ${connection.name} (${error.code})`,
        options.ipAddress || trigger,
        actorEmail
      )];
      if (state.previousStatus !== 'failure') {
        effects.push(notifyOrganizationAdmins(
          organizationId,
          actorEmail,
          'Veri Eşitleme Hatası',
          `"${connection.name}" kaynağı yenilenemedi: ${error.message}`
        ));
      }
      await secondaryEffects(effects);
    }
    throw error;
  }
}
