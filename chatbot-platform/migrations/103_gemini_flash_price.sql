-- El modelo por omisión con OpenRouter para audios, fotos y PDF (google/gemini-2.5-flash) no tenía precio: con el tope de
-- IA de la plataforma (PAY-20), toda llamada sin precio se bloquea, y las cuentas en prueba no transcribían ni leían
-- imágenes. Precios del catálogo de OpenRouter en USD por millón de tokens; la entrada va al precio del audio (el más
-- alto), para que la reserva no se quede corta. El cobro real lo informa OpenRouter.
INSERT INTO ai_prices (model, input_per_mtok, cached_per_mtok, output_per_mtok, per_audio_minute)
VALUES ('google/gemini-2.5-flash', 1.00, 0.25, 2.50, 0)
ON CONFLICT (model) DO NOTHING;
