-- Cotizador escrito: el negocio escribe productos, precios y reglas en texto; la IA lo convierte una vez en la lista de
-- precios y la calculadora. Se guarda el texto (para volver a editarlo) y de qué calculadora salió cada precio (para
-- apagar los que se quiten del texto sin tocar la lista manual).
ALTER TABLE quote_calculators ADD COLUMN IF NOT EXISTS source_text text NOT NULL DEFAULT '';
ALTER TABLE price_items ADD COLUMN IF NOT EXISTS calculator_id uuid REFERENCES quote_calculators(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS price_items_calculator_id_idx ON price_items (calculator_id);

-- Precio del modelo que traduce el texto (por millón de tokens, USD): con límites de gasto, una llamada sin precio no se reserva.
INSERT INTO ai_prices (model, input_per_mtok, cached_per_mtok, output_per_mtok, per_audio_minute)
VALUES ('google/gemini-3.8-flash', 0.75, 0.19, 3.75, 0)
ON CONFLICT (model) DO NOTHING;
