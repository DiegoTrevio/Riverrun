-- API v1: reintentos seguros. Si tu sistema repite un POST o PUT con la misma cabecera Idempotency-Key (porque se cortó
-- la conexión), recibe la misma respuesta en vez de crear el contacto, el cobro o el mensaje otra vez. Se guarda 24 h.
CREATE TABLE api_idempotency (
  api_key_id   uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idem_key     text NOT NULL,
  request_hash text NOT NULL,              -- método, ruta y cuerpo: otra petición con la misma llave es un error
  status_code  integer,                    -- NULL mientras la primera petición sigue en curso
  response     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, idem_key)
);
CREATE INDEX api_idempotency_created_idx ON api_idempotency (created_at);
