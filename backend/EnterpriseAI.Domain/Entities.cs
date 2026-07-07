namespace EnterpriseAI.Domain;

public enum TenantRole
{
    Admin,
    Analyst,
    Viewer
}

public interface ITenantScoped
{
    string TenantId { get; set; }
}

public sealed class TenantRecord : ITenantScoped
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public string TenantId { get; set; } = "";
    public string Name { get; set; } = "";
    public decimal Amount { get; set; }
    public DateTime OccurredAt { get; set; } = DateTime.UtcNow;
}

public sealed class DataSourceConnection : ITenantScoped
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public string TenantId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Provider { get; set; } = "";
    public string EncryptedConnectionString { get; set; } = "";
}

public sealed class EtlJob : ITenantScoped
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public string TenantId { get; set; } = "";
    public string IdempotencyKey { get; set; } = "";
    public string Status { get; set; } = "Queued";
    public string? QualityReportJson { get; set; }
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;
}

public sealed class AuditEntry : ITenantScoped
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public string TenantId { get; set; } = "";
    public string Actor { get; set; } = "";
    public string Action { get; set; } = "";
    public string Resource { get; set; } = "";
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;
}

public sealed class DocumentChunk : ITenantScoped
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public string TenantId { get; set; } = "";
    public string DocumentName { get; set; } = "";
    public int Page { get; set; } = 1;
    public string Text { get; set; } = "";
}

public sealed class NotificationMessage : ITenantScoped
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public string TenantId { get; set; } = "";
    public string Channel { get; set; } = "email";
    public string Recipient { get; set; } = "";
    public string Subject { get; set; } = "";
    public string Body { get; set; } = "";
    public DateTime CreatedAt { get; init; } = DateTime.UtcNow;
}
