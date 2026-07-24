import {
  createKpiDefinition,
  deleteKpiDefinition,
  getKpiDefinition,
  KpiAggregation,
  KpiDefinition,
  KpiDefinitionValues,
  KpiDisplayFormat,
  KpiThresholdType,
  listKpiDefinitions,
  listKpiDefinitionsWithLatest,
  listKpiEvaluationHistory,
  recordKpiEvaluation,
  updateKpiDefinition
} from '../../lib/kpiDb';
import { addAuditLog, addNotification, listOrganizationAdminEmails } from '../../lib/db';
import logger from '../../lib/logger';
import { deliverBusinessAlert } from '../../lib/notificationChannels';
import { getCombinedUserDataset } from '../datasets/combined';
import {
  evaluateKpiDefinition,
  inspectKpiColumns,
  prepareKpiDataset,
  PreparedKpiDataset,
  unavailableKpiEvaluation
} from './engine';

const AGGREGATIONS = new Set<KpiAggregation>(['sum', 'average', 'min', 'max', 'count']);
const DISPLAY_FORMATS = new Set<KpiDisplayFormat>(['number', 'currency', 'percent']);
const THRESHOLD_TYPES = new Set<KpiThresholdType>(['none', 'minimum', 'maximum']);
const DEFINITION_FIELDS = new Set([
  'name',
  'description',
  'columnName',
  'aggregation',
  'displayFormat',
  'thresholdType',
  'thresholdValue',
  'enabled'
]);

export class KpiServiceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'KpiServiceError';
  }
}

export interface EvaluateKpisOptions {
  id?: string;
  ipAddress?: string;
}

function inputObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new KpiServiceError(400, 'INVALID_KPI', 'KPI bilgileri geçerli bir nesne olmalıdır.');
  }
  return input as Record<string, unknown>;
}

function textField(
  value: unknown,
  fieldLabel: string,
  minimum: number,
  maximum: number,
  options: { allowEmpty?: boolean; singleLine?: boolean } = {}
): string {
  if (typeof value !== 'string') {
    throw new KpiServiceError(400, 'INVALID_KPI', `${fieldLabel} metin olmalıdır.`);
  }
  const normalized = value.trim();
  const allowedMinimum = options.allowEmpty ? 0 : minimum;
  if (normalized.length < allowedMinimum || normalized.length > maximum || normalized.includes('\0')) {
    throw new KpiServiceError(
      400,
      'INVALID_KPI',
      options.allowEmpty
        ? `${fieldLabel} en fazla ${maximum} karakter olmalıdır.`
        : `${fieldLabel} ${minimum}-${maximum} karakter arasında olmalıdır.`
    );
  }
  if (options.singleLine && /[\r\n]/.test(normalized)) {
    throw new KpiServiceError(400, 'INVALID_KPI', `${fieldLabel} tek satır olmalıdır.`);
  }
  return normalized;
}

function enumField<T extends string>(value: unknown, allowed: Set<T>, message: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new KpiServiceError(400, 'INVALID_KPI', message);
  }
  return value as T;
}

function finiteThreshold(type: KpiThresholdType, value: unknown): number | null {
  if (type === 'none') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new KpiServiceError(400, 'INVALID_KPI', 'Asgari veya azami eşik için sonlu bir sayısal değer girilmelidir.');
  }
  return value;
}

function parseDefinition(input: unknown, existing?: KpiDefinition): KpiDefinitionValues {
  const body = inputObject(input);
  if (existing && !Object.keys(body).some((key) => DEFINITION_FIELDS.has(key))) {
    throw new KpiServiceError(400, 'EMPTY_UPDATE', 'Güncellenecek en az bir KPI alanı gönderilmelidir.');
  }

  const name = textField(body.name ?? existing?.name, 'KPI adı', 2, 80, { singleLine: true });
  const description = textField(body.description ?? existing?.description ?? '', 'Açıklama', 0, 300, { allowEmpty: true });
  const columnName = textField(body.columnName ?? existing?.columnName, 'Kolon adı', 1, 160, { singleLine: true });
  const aggregation = enumField(
    body.aggregation ?? existing?.aggregation,
    AGGREGATIONS,
    'Hesaplama türü sum, average, min, max veya count olmalıdır.'
  );
  const displayFormat = enumField(
    body.displayFormat ?? existing?.displayFormat ?? 'number',
    DISPLAY_FORMATS,
    'Gösterim biçimi number, currency veya percent olmalıdır.'
  );
  const thresholdType = enumField(
    body.thresholdType ?? existing?.thresholdType ?? 'none',
    THRESHOLD_TYPES,
    'Eşik türü none, minimum veya maximum olmalıdır.'
  );
  const thresholdValue = finiteThreshold(
    thresholdType,
    Object.hasOwn(body, 'thresholdValue') ? body.thresholdValue : existing?.thresholdValue
  );
  const enabledValue = body.enabled ?? existing?.enabled ?? true;
  if (typeof enabledValue !== 'boolean') {
    throw new KpiServiceError(400, 'INVALID_KPI', 'Etkinlik bilgisi boolean olmalıdır.');
  }
  return { name, description, columnName, aggregation, displayFormat, thresholdType, thresholdValue, enabled: enabledValue };
}

export function validateKpiId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw new KpiServiceError(400, 'INVALID_KPI_ID', 'KPI kimliği geçersiz.');
  }
  return id;
}

export function validateHistoryLimit(value: unknown): number {
  if (value === undefined) return 30;
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) < 1 || Number(parsed) > 180) {
    throw new KpiServiceError(400, 'INVALID_LIMIT', 'Geçmiş kayıt limiti 1-180 arasında tam sayı olmalıdır.');
  }
  return Number(parsed);
}

async function writeAudit(
  organizationId: string,
  actorEmail: string,
  action: string,
  details: string,
  ipAddress?: string
): Promise<void> {
  await addAuditLog(organizationId, action, details, ipAddress || 'unknown', actorEmail);
}

export async function getKpiColumnCatalog(organizationId: string) {
  const dataset = await getCombinedUserDataset(organizationId);
  if (!dataset) return { dataset: null, allColumns: [], numericColumns: [] };
  const inspected = inspectKpiColumns(prepareKpiDataset(dataset.file_content));
  return {
    dataset: { filename: dataset.filename, rowCount: dataset.row_count },
    ...inspected
  };
}

export async function getKpisForOrganization(organizationId: string) {
  return listKpiDefinitionsWithLatest(organizationId);
}

export async function getKpiHistoryForOrganization(organizationId: string, id: string, limit: number) {
  const definition = await getKpiDefinition(organizationId, id);
  if (!definition) throw new KpiServiceError(404, 'KPI_NOT_FOUND', 'KPI tanımı bulunamadı.');
  return listKpiEvaluationHistory(organizationId, id, limit);
}

export async function createKpiForOrganization(
  organizationId: string,
  actorEmail: string,
  input: unknown,
  ipAddress?: string
) {
  const definition = await createKpiDefinition(organizationId, actorEmail, parseDefinition(input));
  await writeAudit(organizationId, actorEmail, 'KPI Created', `KPI oluşturuldu: ${definition.name} (${definition.id})`, ipAddress);
  return definition;
}

export async function updateKpiForOrganization(
  organizationId: string,
  actorEmail: string,
  id: string,
  input: unknown,
  ipAddress?: string
) {
  const existing = await getKpiDefinition(organizationId, id);
  if (!existing) throw new KpiServiceError(404, 'KPI_NOT_FOUND', 'KPI tanımı bulunamadı.');
  const definition = await updateKpiDefinition(organizationId, id, parseDefinition(input, existing));
  if (!definition) throw new KpiServiceError(404, 'KPI_NOT_FOUND', 'KPI tanımı bulunamadı.');
  await writeAudit(organizationId, actorEmail, 'KPI Updated', `KPI güncellendi: ${definition.name} (${definition.id})`, ipAddress);
  return definition;
}

export async function deleteKpiForOrganization(
  organizationId: string,
  actorEmail: string,
  id: string,
  ipAddress?: string
) {
  const existing = await getKpiDefinition(organizationId, id);
  if (!existing) throw new KpiServiceError(404, 'KPI_NOT_FOUND', 'KPI tanımı bulunamadı.');
  if (!await deleteKpiDefinition(organizationId, id)) {
    throw new KpiServiceError(404, 'KPI_NOT_FOUND', 'KPI tanımı bulunamadı.');
  }
  await writeAudit(organizationId, actorEmail, 'KPI Deleted', `KPI silindi: ${existing.name} (${existing.id})`, ipAddress);
}

async function notifyTransition(
  organizationId: string,
  definition: KpiDefinition,
  previousStatus: 'healthy' | 'breach' | 'unavailable' | null,
  status: 'healthy' | 'breach' | 'unavailable',
  value: number | null
): Promise<void> {
  let title: string | null = null;
  let message = '';
  if (status === 'breach' && previousStatus !== 'breach') {
    title = 'KPI Eşik Uyarısı';
    message = `"${definition.name}" KPI değeri ${value ?? 'hesaplanamadı'} olarak ölçüldü ve tanımlı ${definition.thresholdType === 'minimum' ? 'asgari' : 'azami'} ${definition.thresholdValue} eşiğini karşılamıyor.`;
  } else if (status === 'healthy' && previousStatus === 'breach') {
    title = 'KPI Yeniden Sağlıklı';
    message = `"${definition.name}" KPI değeri ${value ?? 'hesaplanamadı'} olarak ölçüldü ve yeniden sağlıklı aralığa döndü.`;
  }
  if (!title) return;
  let recipients = [definition.createdBy];
  try {
    const adminEmails = await listOrganizationAdminEmails(organizationId);
    if (adminEmails.length > 0) recipients = adminEmails;
  } catch (error) {
    logger.warn('KPI bildirim yöneticileri belirlenemedi; oluşturan kullanıcıya dönülüyor.', {
      error,
      kpiId: definition.id,
      organizationId
    });
  }
  for (const recipient of new Set(recipients)) {
    try {
      await addNotification(organizationId, title, message, recipient);
    } catch (error) {
      logger.warn('KPI durum bildirimi kaydedilemedi.', {
        error,
        kpiId: definition.id,
        organizationId,
        recipient
      });
    }
  }
  await deliverBusinessAlert(
    organizationId,
    status === 'breach' ? 'kpi_breach' : 'kpi_recovery',
    title,
    message
  ).catch((error) => logger.warn('KPI harici kanal bildirimi tamamlanamadı.', { error, organizationId, kpiId: definition.id }));
}

export async function evaluateKpisForOrganization(
  organizationId: string,
  actorEmail: string,
  options: EvaluateKpisOptions = {}
) {
  const requestedId = options.id ? validateKpiId(options.id) : undefined;
  const definitions = requestedId
    ? await listKpiDefinitions(organizationId, { id: requestedId })
    : await listKpiDefinitions(organizationId, { enabledOnly: true });
  if (requestedId && definitions.length === 0) {
    throw new KpiServiceError(404, 'KPI_NOT_FOUND', 'KPI tanımı bulunamadı.');
  }
  if (definitions.length === 0) return { evaluatedAt: new Date().toISOString(), items: [] };

  let prepared: PreparedKpiDataset | null = null;
  let unavailableReason = 'Analiz kapsamında veri seti bulunamadı.';
  try {
    const dataset = await getCombinedUserDataset(organizationId);
    if (dataset) prepared = prepareKpiDataset(dataset.file_content);
  } catch (error) {
    unavailableReason = error instanceof Error
      ? `Analiz kapsamındaki veri hazırlanamadı: ${error.message}`
      : 'Analiz kapsamındaki veri hazırlanamadı.';
  }

  const items = [];
  for (const definition of definitions) {
    const result = prepared
      ? evaluateKpiDefinition(definition, prepared)
      : unavailableKpiEvaluation(unavailableReason);
    const recorded = await recordKpiEvaluation(organizationId, definition.id, actorEmail, result);
    await notifyTransition(
      organizationId,
      definition,
      recorded.previous?.status || null,
      recorded.evaluation.status,
      recorded.evaluation.value
    );
    items.push({ kpi: definition, evaluation: recorded.evaluation });
  }

  const evaluatedAt = new Date().toISOString();
  await writeAudit(
    organizationId,
    actorEmail,
    'KPI Evaluated',
    `${items.length} KPI değerlendirildi${requestedId ? ` (${requestedId})` : ''}.`,
    options.ipAddress
  );
  return { evaluatedAt, items };
}
