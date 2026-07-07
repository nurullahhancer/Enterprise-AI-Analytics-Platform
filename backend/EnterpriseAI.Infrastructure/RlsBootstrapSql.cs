namespace EnterpriseAI.Infrastructure;

public static class RlsBootstrapSql
{
    public const string Script = """
        alter table tenant_records enable row level security;
        create policy tenant_records_isolation on tenant_records
          using (tenant_id = current_setting('app.tenant_id', true));

        alter table data_source_connections enable row level security;
        create policy data_source_connections_isolation on data_source_connections
          using (tenant_id = current_setting('app.tenant_id', true));

        alter table etl_jobs enable row level security;
        create policy etl_jobs_isolation on etl_jobs
          using (tenant_id = current_setting('app.tenant_id', true));

        alter table audit_entries enable row level security;
        create policy audit_entries_isolation on audit_entries
          using (tenant_id = current_setting('app.tenant_id', true));

        create or replace function block_audit_mutation()
        returns trigger as $$
        begin
          raise exception 'audit_entries is append-only';
        end;
        $$ language plpgsql;

        create trigger audit_entries_append_only
          before update or delete on audit_entries
          for each row execute function block_audit_mutation();

        alter table document_chunks enable row level security;
        create policy document_chunks_isolation on document_chunks
          using (tenant_id = current_setting('app.tenant_id', true));

        alter table notifications enable row level security;
        create policy notifications_isolation on notifications
          using (tenant_id = current_setting('app.tenant_id', true));
        """;
}
