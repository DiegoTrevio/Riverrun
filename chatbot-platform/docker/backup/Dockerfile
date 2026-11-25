# redis-cli para copiar las claves de las sesiones de WhatsApp (Alpine ya no empaqueta Redis): el de la misma imagen
# que usa el stack. En su propia etapa, porque Dependabot solo actualiza las líneas FROM (no un COPY --from=<imagen>).
FROM redis:8-alpine@sha256:7958cfbb9d152f87dadfbc89f1b0b15938f0b81ff8982feb327476f4911935c3 AS rediscli

FROM postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d
# pg_dump/pg_restore 16 (misma versión que el servidor), cifrado autenticado con gpg (openssl para abrir los de antes) y copia a la nube con rclone.
RUN apk add --no-cache bash coreutils tar gzip openssl gnupg rclone tzdata curl
# redis-cli solo necesita libssl/libcrypto, que ya trae openssl.
COPY --from=rediscli /usr/local/bin/redis-cli /usr/local/bin/redis-cli
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["daemon"]
