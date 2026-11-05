FROM postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab
# pg_dump/pg_restore 16 (misma versión que el servidor), cifrado autenticado con gpg (openssl para abrir los de antes) y copia a la nube con rclone.
RUN apk add --no-cache bash coreutils tar gzip openssl gnupg rclone tzdata curl
# redis-cli para copiar las claves de las sesiones de WhatsApp (Alpine ya no empaqueta Redis): el de la misma imagen
# que usa el stack. Solo necesita libssl/libcrypto, que ya trae openssl.
COPY --from=redis:7-alpine@sha256:8da19c7399dca900c6822a1cf30f9d2285585e2c4b457ff4095b0f4500054d3f /usr/local/bin/redis-cli /usr/local/bin/redis-cli
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["daemon"]
