-- Modelo del Copiloto por omisión: DeepSeek V4.1 Flash, el que pasó la prueba con la IA real (npm run eval:copilot:live).
-- Precios del catálogo de OpenRouter, USD por millón de tokens: con límites de gasto, una llamada sin precio no se reserva.
INSERT INTO ai_prices (model, input_per_mtok, cached_per_mtok, output_per_mtok, per_audio_minute)
VALUES ('deepseek/deepseek-v4.1-flash-1017', 0.044, 0.004, 0.383, 0)
ON CONFLICT (model) DO NOTHING;
