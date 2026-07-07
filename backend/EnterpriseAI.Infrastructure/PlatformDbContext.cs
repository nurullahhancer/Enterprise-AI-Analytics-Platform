using EnterpriseAI.Domain;
using EnterpriseAI.Application;
using Microsoft.EntityFrameworkCore;

namespace EnterpriseAI.Infrastructure;

public sealed class PlatformDbContext(DbContextOptions<PlatformDbContext> options, ITenantContext tenantContext) : DbContext(options)
{
    private string? CurrentTenantId => tenantContext.Current?.TenantId;

    public DbSet<TenantRecord> TenantRecords => Set<TenantRecord>();
    public DbSet<DataSourceConnection> DataSourceConnections => Set<DataSourceConnection>();
    public DbSet<EtlJob> EtlJobs => Set<EtlJob>();
    public DbSet<AuditEntry> AuditEntries => Set<AuditEntry>();
    public DbSet<DocumentChunk> DocumentChunks => Set<DocumentChunk>();
    public DbSet<NotificationMessage> Notifications => Set<NotificationMessage>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<TenantRecord>().HasQueryFilter(x => CurrentTenantId == null || x.TenantId == CurrentTenantId);
        modelBuilder.Entity<DataSourceConnection>().HasQueryFilter(x => CurrentTenantId == null || x.TenantId == CurrentTenantId);
        modelBuilder.Entity<EtlJob>().HasQueryFilter(x => CurrentTenantId == null || x.TenantId == CurrentTenantId);
        modelBuilder.Entity<AuditEntry>().HasQueryFilter(x => CurrentTenantId == null || x.TenantId == CurrentTenantId);
        modelBuilder.Entity<DocumentChunk>().HasQueryFilter(x => CurrentTenantId == null || x.TenantId == CurrentTenantId);
        modelBuilder.Entity<NotificationMessage>().HasQueryFilter(x => CurrentTenantId == null || x.TenantId == CurrentTenantId);

        modelBuilder.Entity<TenantRecord>().HasIndex(x => x.TenantId);
        modelBuilder.Entity<DataSourceConnection>().HasIndex(x => x.TenantId);
        modelBuilder.Entity<EtlJob>().HasIndex(x => new { x.TenantId, x.IdempotencyKey }).IsUnique();
        modelBuilder.Entity<AuditEntry>().HasIndex(x => x.TenantId);
        modelBuilder.Entity<DocumentChunk>().HasIndex(x => new { x.TenantId, x.DocumentName });
        modelBuilder.Entity<NotificationMessage>().HasIndex(x => x.TenantId);
    }
}
