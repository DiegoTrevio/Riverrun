-- Copiloto: «Confirmar y seguir». Un pedido de varios pasos que se detuvo en una propuesta anota lo que faltaba
-- (`continue_plan`); al confirmarla, el Copiloto sigue solo en un pedido de continuación (`origin = 'continuation'`),
-- hijo del anterior y con tope de profundidad, que cuenta para los mismos límites que un pedido escrito.
ALTER TABLE copilot_turns
  ADD COLUMN origin text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'continuation')),
  ADD COLUMN parent_turn_id uuid REFERENCES copilot_turns(id) ON DELETE SET NULL,
  ADD COLUMN chain_depth int NOT NULL DEFAULT 0,
  ADD COLUMN continue_plan text NOT NULL DEFAULT '';
CREATE INDEX copilot_turns_parent_idx ON copilot_turns (parent_turn_id);
