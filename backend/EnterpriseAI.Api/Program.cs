using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using EnterpriseAI.Application;
using EnterpriseAI.Domain;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);
var jwtKey = builder.Configuration["Jwt:Key"];
if (string.IsNullOrWhiteSpace(jwtKey) || jwtKey.Length < 32)
    throw new InvalidOperationException("Jwt:Key must be configured with at least 32 characters.");
var connectorSecretKey = builder.Configuration["Secrets:Key"];
if (string.IsNullOrWhiteSpace(connectorSecretKey) || connectorSecretKey.Length < 32)
    throw new InvalidOperationException("Secrets:Key must be configured with at least 32 characters.");
var signingKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey));

builder.Services.AddSingleton<InMemoryPlatformStore>();
builder.Services.AddSingleton<IImportSchemaDetector, ImportSchemaDetector>();
builder.Services.AddSingleton<IDataQualityValidator, DataQualityValidator>();
builder.Services.AddSingleton<IConnectionSecretProtector>(_ => new AesConnectionSecretProtector(connectorSecretKey));
builder.Services.AddSingleton<ISqlGuard, SqlGuard>();
builder.Services.AddSingleton<IAgentGuardrail, AgentGuardrail>();
builder.Services.AddSingleton<IKnowledgeBase, InMemoryKnowledgeBase>();
builder.Services.AddSingleton<IReportExporter, ReportExporter>();
builder.Services.AddSingleton<INotificationSink, NotificationSink>();
builder.Services.AddSingleton<IPlatformMetrics, PlatformMetrics>();
builder.Services.AddHttpClient<IRestConnector, RestConnector>();
builder.Services.AddScoped<ITenantContext, TenantContext>();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddCors(options =>
{
    options.AddPolicy("mobile-dev", policy =>
        policy
            .WithOrigins(
                "http://localhost",
                "http://localhost:5173",
                "http://127.0.0.1:5173",
                "capacitor://localhost",
                "http://10.0.2.2")
            .AllowAnyHeader()
            .AllowAnyMethod());
});
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = false,
            ValidateAudience = false,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = signingKey,
            ValidateLifetime = true,
            RoleClaimType = ClaimTypes.Role
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();
if (app.Environment.IsDevelopment() || app.Environment.IsEnvironment("Testing"))
{
    app.UseSwagger();
    app.UseSwaggerUI();
}
app.UseCors("mobile-dev");
app.Use(async (context, next) =>
{
    var metrics = context.RequestServices.GetRequiredService<IPlatformMetrics>();
    var started = DateTimeOffset.UtcNow;
    try
    {
        await next();
    }
    finally
    {
        metrics.Record(DateTimeOffset.UtcNow - started, context.Response.StatusCode >= 500);
    }
});
app.UseAuthentication();
app.Use(async (context, next) =>
{
    var tenantContext = context.RequestServices.GetRequiredService<ITenantContext>();
    if (context.User.Identity?.IsAuthenticated == true)
    {
        var roleText = context.User.FindFirstValue(ClaimTypes.Role) ?? "Viewer";
        Enum.TryParse<TenantRole>(roleText, out var role);
        tenantContext.Current = new TenantPrincipal(
            context.User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "unknown",
            context.User.FindFirstValue("tenant_id") ?? "tenant-a",
            role);
    }
    await next();
});
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "ok", service = "backend" }));

app.MapGet("/observability/metrics", (IPlatformMetrics metrics) => Results.Ok(metrics.Snapshot()));
app.MapGet("/metrics", (IPlatformMetrics metrics) =>
{
    var snapshot = metrics.Snapshot();
    var text = new StringBuilder()
        .AppendLine("# HELP enterprise_ai_requests_total Total HTTP requests observed by the API.")
        .AppendLine("# TYPE enterprise_ai_requests_total counter")
        .AppendLine($"enterprise_ai_requests_total {snapshot.RequestCount}")
        .AppendLine("# HELP enterprise_ai_errors_total Total HTTP 5xx responses observed by the API.")
        .AppendLine("# TYPE enterprise_ai_errors_total counter")
        .AppendLine($"enterprise_ai_errors_total {snapshot.ErrorCount}")
        .AppendLine("# HELP enterprise_ai_average_latency_ms Average API latency in milliseconds.")
        .AppendLine("# TYPE enterprise_ai_average_latency_ms gauge")
        .AppendLine($"enterprise_ai_average_latency_ms {snapshot.AverageLatencyMs}")
        .ToString();
    return Results.Text(text, "text/plain");
});

app.MapPost("/auth/login", (LoginRequest request) =>
{
    if (!app.Environment.IsEnvironment("Testing")) return Results.NotFound();
    var role = request.Role ?? "Admin";
    var tenantId = request.TenantId ?? "tenant-a";
    var claims = new[]
    {
        new Claim(JwtRegisteredClaimNames.Sub, request.Email),
        new Claim("tenant_id", tenantId),
        new Claim(ClaimTypes.Role, role)
    };
    var token = new JwtSecurityToken(claims: claims, expires: DateTime.UtcNow.AddHours(4),
        signingCredentials: new SigningCredentials(signingKey, SecurityAlgorithms.HmacSha256));
    return Results.Ok(new { access_token = new JwtSecurityTokenHandler().WriteToken(token), tenant_id = tenantId, role });
});

app.MapGet("/tenant-records", [Authorize(Roles = "Admin,Analyst,Viewer")] (ITenantContext tenant, InMemoryPlatformStore store) =>
{
    var tenantId = tenant.Current!.TenantId;
    return store.Records.Where(r => r.TenantId == tenantId);
});

app.MapDelete("/tenant-records/{id:guid}", [Authorize(Roles = "Admin")] (Guid id, ITenantContext tenant, InMemoryPlatformStore store) =>
{
    var removed = store.Records.RemoveAll(r => r.Id == id && r.TenantId == tenant.Current!.TenantId);
    return removed == 0 ? Results.NotFound() : Results.NoContent();
});

app.MapPost("/imports/preview", [Authorize(Roles = "Admin,Analyst")] (CsvPayload request, IImportSchemaDetector detector) =>
    Results.Ok(detector.PreviewCsv(request.Csv)));

app.MapPost("/connectors/sql", [Authorize(Roles = "Admin")] (SqlConnectionRequest request, ITenantContext tenant, IConnectionSecretProtector protector, InMemoryPlatformStore store) =>
{
    var item = new DataSourceConnection
    {
        TenantId = tenant.Current!.TenantId,
        Name = request.Name,
        Provider = request.Provider,
        EncryptedConnectionString = protector.Protect(request.ConnectionString)
    };
    store.Connections.Add(item);
    return Results.Created($"/connectors/sql/{item.Id}", new { item.Id, item.Name, item.Provider, plaintextStored = item.EncryptedConnectionString.Contains(request.ConnectionString) });
});

app.MapPost("/connectors/rest/fetch", [Authorize(Roles = "Admin,Analyst")] async (RestConnectorRequest request, IRestConnector connector, CancellationToken cancellationToken) =>
{
    try
    {
        return Results.Ok(await connector.FetchAsync(request, cancellationToken));
    }
    catch (Exception ex) when (ex is ArgumentException or HttpRequestException or InvalidOperationException or JsonException)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/etl/events", [Authorize(Roles = "Admin,Analyst")] (EtlEventRequest request, ITenantContext tenant, IDataQualityValidator validator, INotificationSink notifications, InMemoryPlatformStore store) =>
{
    var job = store.Enqueue(new EtlEvent(tenant.Current!.TenantId, request.IdempotencyKey, request.Csv), validator);
    notifications.Enqueue(tenant.Current.TenantId, request.NotifyEmail ?? "ops@example.test", $"ETL job {job.Status}", $"Job {job.Id} finished with status {job.Status}.");
    return Results.Accepted($"/etl/jobs/{job.Id}", job);
});

app.MapGet("/etl/jobs/{id:guid}", [Authorize(Roles = "Admin,Analyst,Viewer")] (Guid id, ITenantContext tenant, InMemoryPlatformStore store) =>
    store.Jobs.FirstOrDefault(j => j.Id == id && j.TenantId == tenant.Current!.TenantId) is { } job ? Results.Ok(job) : Results.NotFound());

app.MapPost("/ai/sql", [Authorize(Roles = "Admin,Analyst,Viewer")] (SqlRequest request, ISqlGuard guard, ITenantContext tenant, InMemoryPlatformStore store) =>
{
    if (!guard.IsReadOnlySelect(request.Sql)) return Results.BadRequest(new { error = "Only read-only SELECT SQL is allowed." });
    store.TokenUsageByTenant[tenant.Current!.TenantId] = store.TokenUsageByTenant.GetValueOrDefault(tenant.Current!.TenantId) + request.Sql.Length / 4;
    return Results.Ok(new { sql = request.Sql, rows = Array.Empty<object>() });
});

app.MapPost("/ai/guardrails/inspect", [Authorize(Roles = "Admin,Analyst,Viewer")] (GuardrailRequest request, IAgentGuardrail guardrail) =>
{
    var result = guardrail.Inspect(request.Input);
    return result.Allowed ? Results.Ok(result) : Results.BadRequest(result);
});

app.MapPost("/rag/documents", [Authorize(Roles = "Admin,Analyst")] (RagIngestRequest request, ITenantContext tenant, IKnowledgeBase knowledgeBase) =>
{
    try
    {
        var citations = knowledgeBase.Ingest(tenant.Current!.TenantId, request);
        return Results.Created($"/rag/documents/{request.DocumentName}", new { chunks = citations.Count, citations });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/rag/query", [Authorize(Roles = "Admin,Analyst,Viewer")] (RagQueryRequest request, ITenantContext tenant, IKnowledgeBase knowledgeBase) =>
    Results.Ok(knowledgeBase.Query(tenant.Current!.TenantId, request.Question)));

app.MapPost("/reports/export", [Authorize(Roles = "Admin,Analyst")] (ReportExportRequest request, IReportExporter exporter) =>
{
    try
    {
        return Results.Ok(exporter.Export(request));
    }
    catch (ArgumentException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/agent/run", [Authorize(Roles = "Admin,Analyst")] (AgentRunRequest request, ITenantContext tenant, IAgentGuardrail guardrail, IReportExporter exporter, InMemoryPlatformStore store) =>
{
    var inspected = guardrail.Inspect(request.Goal);
    if (!inspected.Allowed) return Results.BadRequest(inspected);

    var tenantRecords = store.Records.Where(x => x.TenantId == tenant.Current!.TenantId).ToList();
    var average = tenantRecords.Count == 0 ? 0 : tenantRecords.Average(x => x.Amount);
    var anomalies = tenantRecords.Where(x => x.Amount > average * 1.8m).Select(x => new Dictionary<string, object?>
    {
        ["name"] = x.Name,
        ["amount"] = x.Amount,
        ["occurredAt"] = x.OccurredAt
    }).ToList();
    var report = exporter.Export(new ReportExportRequest("Anomaly Report", anomalies, "pdf"));
    return Results.Ok(new { steps = new[] { "guardrails.inspect", "records.anomaly_scan", "reports.export" }, anomalies = anomalies.Count, report });
});

app.MapPost("/audit", [Authorize] (AuditRequest request, ITenantContext tenant, IAgentGuardrail guardrail, InMemoryPlatformStore store) =>
{
    var entry = new AuditEntry
    {
        TenantId = tenant.Current!.TenantId,
        Actor = tenant.Current.UserId,
        Action = guardrail.Inspect(request.Action).SanitizedText,
        Resource = guardrail.Inspect(request.Resource).SanitizedText
    };
    store.AuditEntries.Add(entry);
    return Results.Created($"/audit/{entry.Id}", entry);
});

app.MapGet("/billing/usage", [Authorize(Roles = "Admin")] (ITenantContext tenant, InMemoryPlatformStore store) =>
    Results.Ok(new { tenant_id = tenant.Current!.TenantId, ai_tokens = store.TokenUsageByTenant.GetValueOrDefault(tenant.Current.TenantId) }));

app.MapGet("/notifications", [Authorize(Roles = "Admin")] (ITenantContext tenant, InMemoryPlatformStore store) =>
    Results.Ok(store.Notifications.Where(x => x.TenantId == tenant.Current!.TenantId)));

app.Run();

public sealed record LoginRequest(string Email, string? TenantId, string? Role);
public sealed record CsvPayload(string Csv);
public sealed record SqlConnectionRequest(string Name, string Provider, string ConnectionString);
public sealed record EtlEventRequest(string IdempotencyKey, string Csv, string? NotifyEmail);
public sealed record SqlRequest(string Sql);
public sealed record GuardrailRequest(string Input);
public sealed record AuditRequest(string Action, string Resource);
public sealed record RagQueryRequest(string Question);
public sealed record AgentRunRequest(string Goal);

public partial class Program;
