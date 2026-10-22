FROM postgres:16-alpine
# pg_dump/pg_restore 16 (misma versión que el servidor), cifrado con openssl y copia a la nube con rclone.
RUN apk add --no-cache bash coreutils tar gzip openssl rclone tzdata curl
# redis-cli para copiar las claves de las sesiones de WhatsApp (Alpine ya no empaqueta Redis): el de la misma imagen
# que usa el stack. Solo necesita libssl/libcrypto, que ya trae openssl.
COPY --from=redis:7-alpine /usr/local/bin/redis-cli /usr/local/bin/redis-cli
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["daemon"]
