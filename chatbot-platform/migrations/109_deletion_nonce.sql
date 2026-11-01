-- Bajos de la 2c: el enlace para confirmar el borrado de la cuenta sirve una sola vez. Lleva un número de un solo uso que
-- se guarda al pedirlo, se consume al confirmar y se borra al cancelar el borrado o transferir la cuenta (los enlaces que
-- ya se mandaron dejan de servir).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deletion_nonce text;
