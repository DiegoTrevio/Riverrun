FROM postgres:16-alpine
# pg_dump/pg_restore 16 (misma versión que el servidor), cifrado con openssl y copia a la nube con rclone.
RUN apk add --no-cache bash coreutils tar gzip openssl rclone tzdata curl
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["daemon"]
