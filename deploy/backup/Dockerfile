FROM postgres:17-alpine
RUN apk add --no-cache age \
    && rm -f /usr/local/bin/gosu
COPY backup-loop.sh restore-check.sh /scripts/
RUN chmod 755 /scripts/backup-loop.sh /scripts/restore-check.sh \
    && mkdir -p /backups \
    && chown postgres:postgres /backups
USER postgres
