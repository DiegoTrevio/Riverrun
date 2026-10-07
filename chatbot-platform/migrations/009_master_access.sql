-- One-time assignment requested by the owner. Preserve the existing password.
-- Never create an account or grant privileges on signup based on its email alone.
UPDATE users SET role = 'superadmin', account_id = NULL, active = true, updated_at = now()
WHERE lower(email) = 'diegoa.trevio@gmail.com' AND email_verified_at IS NOT NULL;
