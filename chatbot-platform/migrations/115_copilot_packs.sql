-- Copiloto: herramientas por paquetes. Cada pedido guarda qué paquetes tuvo cargados (además del núcleo), para que el
-- siguiente pedido de la misma conversación los conserve.
ALTER TABLE copilot_turns ADD COLUMN packs text[] NOT NULL DEFAULT '{}';
