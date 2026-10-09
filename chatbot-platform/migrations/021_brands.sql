-- Marca blanca: nombre, logo, color y dominio propios que el superadmin asigna a cada cuenta.
CREATE TABLE brands (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,                       -- nombre que ve el cliente (panel, correos, pestaña)
  color         text NOT NULL DEFAULT '',            -- #rrggbb; vacío = color de la plataforma
  domain        text UNIQUE,                         -- panel.miagencia.com (en minúsculas, sin puerto)
  support_email text NOT NULL DEFAULT '',
  logo          bytea,
  logo_type     text NOT NULL DEFAULT '',
  logo_version  integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE accounts ADD COLUMN brand_id uuid REFERENCES brands(id) ON DELETE SET NULL;
