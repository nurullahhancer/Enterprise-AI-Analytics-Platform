using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using EnterpriseAI.Domain;

namespace EnterpriseAI.Application;

public sealed class TenantContext : ITenantContext
{
    public TenantPrincipal? Current { get; set; }
}

public sealed class ImportSchemaDetector : IImportSchemaDetector
{
    public ImportPreview PreviewCsv(string csv, int previewRows = 5)
    {
        var rows = Parse(csv);
        if (rows.Count == 0) return new ImportPreview([], []);

        var headers = rows[0];
        var body = rows.Skip(1).ToList();
        var schemas = headers.Select((header, index) =>
        {
            var values = body.Select(r => index < r.Count ? r[index] : "").ToList();
            var nonEmpty = values.Where(v => !string.IsNullOrWhiteSpace(v)).ToList();
            var type = InferType(nonEmpty);
            var nullRatio = values.Count == 0 ? 0 : values.Count(v => string.IsNullOrWhiteSpace(v)) / (double)values.Count;
            return new ColumnSchema(header, type, Math.Round(nullRatio, 3));
        }).ToList();

        var preview = body.Take(previewRows)
            .Select(row => headers.Select((h, i) => new { h, value = i < row.Count ? row[i] : "" })
                .ToDictionary(x => x.h, x => x.value))
            .ToList();

        return new ImportPreview(schemas, preview);
    }

    private static string InferType(IReadOnlyList<string> values)
    {
        if (values.Count == 0) return "string";
        if (values.All(v => int.TryParse(v, out _))) return "int";
        if (values.All(v => decimal.TryParse(v, out _))) return "float";
        if (values.All(v => DateTime.TryParse(v, out _))) return "date";
        return "string";
    }

    internal static List<List<string>> Parse(string csv) =>
        csv.Replace("\r\n", "\n").Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split(',').Select(cell => cell.Trim().Trim('"')).ToList())
            .ToList();
}

public sealed class DataQualityValidator : IDataQualityValidator
{
    public DataQualityReport ValidateCsv(string csv)
    {
        var rows = ImportSchemaDetector.Parse(csv);
        if (rows.Count < 2) return new DataQualityReport(Math.Max(rows.Count - 1, 0), 0, ["CSV contains no data rows."]);

        var width = rows[0].Count;
        var issues = new List<string>();
        var body = rows.Skip(1).ToList();
        var duplicates = body.GroupBy(r => string.Join('\u001f', r)).Where(g => g.Count() > 1).Sum(g => g.Count() - 1);
        var malformed = body.Count(r => r.Count != width);
        if (malformed > 0) issues.Add($"{malformed} rows have a different column count.");
        if (duplicates > 0) issues.Add($"{duplicates} duplicate rows detected.");

        return new DataQualityReport(body.Count, duplicates, issues);
    }
}

public sealed class AesConnectionSecretProtector : IConnectionSecretProtector
{
    private readonly byte[] _key;

    public AesConnectionSecretProtector(string keyMaterial)
    {
        _key = SHA256.HashData(Encoding.UTF8.GetBytes(keyMaterial));
    }

    public string Protect(string plaintext)
    {
        using var aes = Aes.Create();
        aes.Key = _key;
        aes.GenerateIV();
        using var encryptor = aes.CreateEncryptor();
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        var cipher = encryptor.TransformFinalBlock(bytes, 0, bytes.Length);
        return Convert.ToBase64String(aes.IV.Concat(cipher).ToArray());
    }

    public string Unprotect(string ciphertext)
    {
        var bytes = Convert.FromBase64String(ciphertext);
        using var aes = Aes.Create();
        aes.Key = _key;
        aes.IV = bytes.Take(16).ToArray();
        using var decryptor = aes.CreateDecryptor();
        var plain = decryptor.TransformFinalBlock(bytes, 16, bytes.Length - 16);
        return Encoding.UTF8.GetString(plain);
    }
}

public sealed class SqlGuard : ISqlGuard
{
    private static readonly string[] Denied = ["insert", "update", "delete", "drop", "alter", "truncate", "create", "grant", "revoke", "merge", "execute", "exec"];

    public bool IsReadOnlySelect(string sql)
    {
        var normalized = sql.Trim().TrimEnd(';').ToLowerInvariant();
        if (!normalized.StartsWith("select ") && !normalized.StartsWith("with ")) return false;
        return !Denied.Any(word => normalized.Split([' ', '\n', '\r', '\t', ';', ','], StringSplitOptions.RemoveEmptyEntries).Contains(word));
    }
}

public sealed class AgentGuardrail : IAgentGuardrail
{
    private static readonly Regex Email = new(@"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex CreditCardLike = new(@"\b(?:\d[ -]*?){13,19}\b", RegexOptions.Compiled);
    private static readonly string[] InjectionSignals =
    [
        "ignore previous instructions",
        "forget previous instructions",
        "disregard the system",
        "delete all user data",
        "drop table",
        "reveal hidden prompt",
        "önceki talimatları unut",
        "tüm kullanıcı verilerini sil",
        "sistem talimatını göster"
    ];

    public GuardrailResult Inspect(string input)
    {
        var normalized = input.ToLowerInvariant();
        var signal = InjectionSignals.FirstOrDefault(normalized.Contains);
        var sanitized = CreditCardLike.Replace(Email.Replace(input, "[redacted-email]"), "[redacted-number]");
        return signal is null
            ? new GuardrailResult(true, null, sanitized)
            : new GuardrailResult(false, $"Prompt injection signal detected: {signal}", sanitized);
    }
}

public sealed class RestConnector(HttpClient httpClient) : IRestConnector
{
    public async Task<RestConnectorResult> FetchAsync(RestConnectorRequest request, CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(request.Url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        {
            throw new ArgumentException("REST connector URL must be an absolute HTTP(S) URL.");
        }

        using var message = new HttpRequestMessage(HttpMethod.Get, uri);
        if (!string.IsNullOrWhiteSpace(request.ApiKeyHeader) && !string.IsNullOrWhiteSpace(request.ApiKey))
        {
            message.Headers.TryAddWithoutValidation(request.ApiKeyHeader, request.ApiKey);
        }

        using var response = await httpClient.SendAsync(message, cancellationToken);
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadAsStringAsync(cancellationToken);
        var root = JsonNode.Parse(json) ?? throw new InvalidOperationException("REST connector response is not valid JSON.");
        var items = root is JsonArray array ? array : new JsonArray(root.DeepClone());
        var rows = items.Select(item => ApplyMapping(item, request.Mapping)).ToList();
        return new RestConnectorResult(rows);
    }

    private static Dictionary<string, object?> ApplyMapping(JsonNode? item, Dictionary<string, string>? mapping)
    {
        if (mapping is null || mapping.Count == 0)
        {
            return item?.AsObject().ToDictionary(pair => pair.Key, pair => ToValue(pair.Value)) ?? [];
        }

        return mapping.ToDictionary(pair => pair.Key, pair => ToValue(ReadPath(item, pair.Value)));
    }

    private static JsonNode? ReadPath(JsonNode? node, string path)
    {
        foreach (var segment in path.Trim().TrimStart('$').TrimStart('.').Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            node = node?[segment];
        }

        return node;
    }

    private static object? ToValue(JsonNode? node)
    {
        if (node is null) return null;
        if (node is not JsonValue value) return node.ToJsonString();
        if (value.TryGetValue<string>(out var text)) return text;
        if (value.TryGetValue<decimal>(out var number)) return number;
        if (value.TryGetValue<bool>(out var boolean)) return boolean;
        return node.ToJsonString();
    }
}

public sealed class InMemoryKnowledgeBase(InMemoryPlatformStore store, IAgentGuardrail guardrail) : IKnowledgeBase
{
    public IReadOnlyList<RagCitation> Ingest(string tenantId, RagIngestRequest request)
    {
        var inspected = guardrail.Inspect(request.Text);
        if (!inspected.Allowed)
        {
            throw new InvalidOperationException(inspected.Reason ?? "Document failed guardrail inspection.");
        }

        var pageSize = Math.Clamp(request.PageSize, 200, 2_000);
        var chunks = inspected.SanitizedText
            .Chunk(pageSize)
            .Select((chars, index) => new DocumentChunk
            {
                TenantId = tenantId,
                DocumentName = request.DocumentName,
                Page = index + 1,
                Text = new string(chars)
            })
            .ToList();

        store.DocumentChunks.RemoveAll(x => x.TenantId == tenantId && x.DocumentName == request.DocumentName);
        store.DocumentChunks.AddRange(chunks);
        return chunks.Select(x => new RagCitation(x.DocumentName, x.Page, x.Text)).ToList();
    }

    public RagAnswer Query(string tenantId, string question)
    {
        var terms = Regex.Matches(question.ToLowerInvariant(), @"[\p{L}\p{N}]{3,}")
            .Select(match => match.Value)
            .Distinct()
            .ToList();

        var citations = store.DocumentChunks
            .Where(x => x.TenantId == tenantId)
            .Select(chunk => new
            {
                Chunk = chunk,
                Score = terms.Count(term => chunk.Text.Contains(term, StringComparison.OrdinalIgnoreCase))
            })
            .Where(x => x.Score > 0)
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Chunk.Page)
            .Take(3)
            .Select(x => new RagCitation(x.Chunk.DocumentName, x.Chunk.Page, TrimSnippet(x.Chunk.Text)))
            .ToList();

        var answer = citations.Count == 0
            ? "No relevant document context was found for this tenant."
            : $"Found {citations.Count} relevant source chunk(s). Review the citations before using the answer.";
        return new RagAnswer(answer, citations);
    }

    private static string TrimSnippet(string text) => text.Length <= 240 ? text : text[..240];
}

public sealed class ReportExporter : IReportExporter
{
    public ReportExportResult Export(ReportExportRequest request)
    {
        var format = request.Format.Trim().ToLowerInvariant();
        return format switch
        {
            "excel" or "csv" => ExportCsv(request),
            "pdf" => ExportPdf(request),
            _ => throw new ArgumentException("Report format must be pdf, excel, or csv.")
        };
    }

    private static ReportExportResult ExportCsv(ReportExportRequest request)
    {
        var headers = request.Rows.SelectMany(row => row.Keys).Distinct().ToList();
        var lines = new List<string> { string.Join(",", headers.Select(EscapeCsv)) };
        lines.AddRange(request.Rows.Select(row => string.Join(",", headers.Select(header => EscapeCsv(row.GetValueOrDefault(header)?.ToString() ?? "")))));
        var bytes = Encoding.UTF8.GetBytes(string.Join(Environment.NewLine, lines));
        return new ReportExportResult($"{Slug(request.Title)}.csv", "text/csv", Convert.ToBase64String(bytes));
    }

    private static ReportExportResult ExportPdf(ReportExportRequest request)
    {
        var rows = request.Rows.Select(row => string.Join(" | ", row.Select(pair => $"{pair.Key}: {pair.Value}")));
        var body = $"%PDF-1.4\n% Enterprise AI Analytics MVP report\nTitle: {request.Title}\n{string.Join("\n", rows)}\n%%EOF";
        return new ReportExportResult($"{Slug(request.Title)}.pdf", "application/pdf", Convert.ToBase64String(Encoding.UTF8.GetBytes(body)));
    }

    private static string EscapeCsv(string value) => value.Contains(',') || value.Contains('"') || value.Contains('\n')
        ? $"\"{value.Replace("\"", "\"\"")}\""
        : value;

    private static string Slug(string value) => Regex.Replace(value.ToLowerInvariant(), @"[^a-z0-9]+", "-").Trim('-');
}

public sealed class NotificationSink(InMemoryPlatformStore store) : INotificationSink
{
    public NotificationMessage Enqueue(string tenantId, string recipient, string subject, string body)
    {
        var message = new NotificationMessage
        {
            TenantId = tenantId,
            Recipient = recipient,
            Subject = subject,
            Body = body
        };
        store.Notifications.Add(message);
        return message;
    }
}

public sealed class PlatformMetrics : IPlatformMetrics
{
    private long _requestCount;
    private long _errorCount;
    private long _totalLatencyMs;

    public void Record(TimeSpan elapsed, bool failed)
    {
        Interlocked.Increment(ref _requestCount);
        if (failed) Interlocked.Increment(ref _errorCount);
        Interlocked.Add(ref _totalLatencyMs, (long)elapsed.TotalMilliseconds);
    }

    public MetricsSnapshot Snapshot()
    {
        var requests = Interlocked.Read(ref _requestCount);
        var totalLatency = Interlocked.Read(ref _totalLatencyMs);
        return new MetricsSnapshot(
            requests,
            Interlocked.Read(ref _errorCount),
            requests == 0 ? 0 : Math.Round(totalLatency / (double)requests, 2));
    }
}

public sealed class InMemoryPlatformStore
{
    public List<TenantRecord> Records { get; } =
    [
        new() { TenantId = "tenant-a", Name = "Sale A", Amount = 1200, OccurredAt = DateTime.UtcNow.AddDays(-10) },
        new() { TenantId = "tenant-b", Name = "Sale B", Amount = 9999, OccurredAt = DateTime.UtcNow.AddDays(-8) }
    ];

    public List<DataSourceConnection> Connections { get; } = [];
    public List<EtlJob> Jobs { get; } = [];
    public List<EtlEvent> DeadLetters { get; } = [];
    public List<AuditEntry> AuditEntries { get; } = [];
    public List<DocumentChunk> DocumentChunks { get; } = [];
    public List<NotificationMessage> Notifications { get; } = [];
    public Dictionary<string, int> TokenUsageByTenant { get; } = [];

    public EtlJob Enqueue(EtlEvent evt, IDataQualityValidator validator)
    {
        var existing = Jobs.FirstOrDefault(j => j.TenantId == evt.TenantId && j.IdempotencyKey == evt.IdempotencyKey);
        if (existing is not null) return existing;

        var job = new EtlJob { TenantId = evt.TenantId, IdempotencyKey = evt.IdempotencyKey };
        Jobs.Add(job);
        try
        {
            var report = validator.ValidateCsv(evt.Payload);
            job.QualityReportJson = JsonSerializer.Serialize(report);
            job.Status = report.Issues.Count == 0 ? "Completed" : "CompletedWithWarnings";
        }
        catch
        {
            job.Status = "Failed";
            DeadLetters.Add(evt);
        }

        return job;
    }
}
