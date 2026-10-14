-- Oportunidades: cada tarjeta del pipeline puede tener un valor (lo que vale la venta o el servicio) y cada pipeline su
-- moneda; el tablero suma el valor de cada columna.
ALTER TABLE pipeline_cards ADD COLUMN IF NOT EXISTS value numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'MXN';
