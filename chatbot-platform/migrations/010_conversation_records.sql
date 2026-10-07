-- Captured answers and the operational summary are separate from compressed AI memory.
ALTER TABLE conversations
  ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN data_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN report_summary text NOT NULL DEFAULT '',
  ADD COLUMN report_until_id bigint NOT NULL DEFAULT 0,
  ADD COLUMN report_at timestamptz,
  ADD COLUMN report_data_version bigint NOT NULL DEFAULT -1;
UPDATE conversations cv SET data = ct.data FROM contacts ct WHERE ct.id = cv.contact_id;

ALTER TABLE contacts ADD CONSTRAINT contacts_data_object CHECK (jsonb_typeof(data) = 'object' AND NOT jsonb_path_exists(data, '$.* ? (@.type() != "string")'));
ALTER TABLE contacts ADD CONSTRAINT contacts_notes_array CHECK (jsonb_typeof(notes) = 'array' AND NOT jsonb_path_exists(notes, '$[*] ? (@.type() != "string")'));
ALTER TABLE conversations ADD CONSTRAINT conversations_data_object CHECK (jsonb_typeof(data) = 'object' AND NOT jsonb_path_exists(data, '$.* ? (@.type() != "string")'));
ALTER TABLE conversations ADD CONSTRAINT conversations_report_cursor CHECK (report_until_id >= 0 AND data_version >= 0);

-- The database also enforces tenant ownership, even for direct SQL/imports.
ALTER TABLE chatbots ADD CONSTRAINT chatbots_id_account_key UNIQUE (id, account_id);
ALTER TABLE channels ADD CONSTRAINT channels_id_account_key UNIQUE (id, account_id);
ALTER TABLE contacts ADD CONSTRAINT contacts_id_channel_account_key UNIQUE (id, channel_id, account_id);
ALTER TABLE channels ADD CONSTRAINT channels_bot_account_fk FOREIGN KEY (chatbot_id, account_id)
  REFERENCES chatbots (id, account_id) ON DELETE SET NULL (chatbot_id);
ALTER TABLE contacts ADD CONSTRAINT contacts_channel_account_fk FOREIGN KEY (channel_id, account_id)
  REFERENCES channels (id, account_id) ON DELETE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_account_fk FOREIGN KEY (channel_id, account_id)
  REFERENCES channels (id, account_id) ON DELETE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_contact_scope_fk FOREIGN KEY (contact_id, channel_id, account_id)
  REFERENCES contacts (id, channel_id, account_id) ON DELETE CASCADE;
ALTER TABLE conversations ADD CONSTRAINT conversations_bot_account_fk FOREIGN KEY (chatbot_id, account_id)
  REFERENCES chatbots (id, account_id) ON DELETE SET NULL (chatbot_id);
