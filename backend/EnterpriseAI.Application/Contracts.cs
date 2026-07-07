using EnterpriseAI.Domain;

namespace EnterpriseAI.Application;

public sealed record TenantPrincipal(string UserId, string TenantId, TenantRole Role);
public sealed record ColumnSchema(string Name, string Type, double NullRatio);
public sealed record DataQualityReport(int RowCount, int DuplicateRows, IReadOnlyList<string> Issues);
public sealed record ImportPreview(IReadOnlyList<ColumnSchema> Columns, IReadOnlyList<Dictionary<string, string>> Rows);
public sealed record EtlEvent(string TenantId, string IdempotencyKey, string Payload);
public sealed record RestConnectorRequest(string Url, string? ApiKeyHeader, string? ApiKey, Dictionary<string, string>? Mapping);
public sealed record RestConnectorResult(IReadOnlyList<Dictionary<string, object?>> Rows);
public sealed record GuardrailResult(bool Allowed, string? Reason, string SanitizedText);
public sealed record RagIngestRequest(string DocumentName, string Text, int PageSize = 900);
public sealed record RagCitation(string DocumentName, int Page, string Snippet);
public sealed record RagAnswer(string Answer, IReadOnlyList<RagCitation> Citations);
public sealed record ReportExportRequest(string Title, IReadOnlyList<Dictionary<string, object?>> Rows, string Format);
public sealed record ReportExportResult(string FileName, string ContentType, string Base64Content);
public sealed record MetricsSnapshot(long RequestCount, long ErrorCount, double AverageLatencyMs);

public interface ITenantContext
{
    TenantPrincipal? Current { get; set; }
}

public interface IImportSchemaDetector
{
    ImportPreview PreviewCsv(string csv, int previewRows = 5);
}

public interface IDataQualityValidator
{
    DataQualityReport ValidateCsv(string csv);
}

public interface IConnectionSecretProtector
{
    string Protect(string plaintext);
    string Unprotect(string ciphertext);
}

public interface ISqlGuard
{
    bool IsReadOnlySelect(string sql);
}

public interface IRestConnector
{
    Task<RestConnectorResult> FetchAsync(RestConnectorRequest request, CancellationToken cancellationToken = default);
}

public interface IAgentGuardrail
{
    GuardrailResult Inspect(string input);
}

public interface IKnowledgeBase
{
    IReadOnlyList<RagCitation> Ingest(string tenantId, RagIngestRequest request);
    RagAnswer Query(string tenantId, string question);
}

public interface IReportExporter
{
    ReportExportResult Export(ReportExportRequest request);
}

public interface INotificationSink
{
    NotificationMessage Enqueue(string tenantId, string recipient, string subject, string body);
}

public interface IPlatformMetrics
{
    void Record(TimeSpan elapsed, bool failed);
    MetricsSnapshot Snapshot();
}
