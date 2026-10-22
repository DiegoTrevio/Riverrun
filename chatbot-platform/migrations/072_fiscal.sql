-- Datos fiscales del cliente para su CFDI («con o sin factura»). Sin factura, sus pagos van a la factura global.
-- Se borran con la cuenta; cada CFDI guarda la copia de los datos con que se emitió.
CREATE TABLE account_fiscal (
  account_id    uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  wants_invoice boolean NOT NULL DEFAULT false,
  rfc           text NOT NULL DEFAULT '',
  legal_name    text NOT NULL DEFAULT '',
  tax_regime    text NOT NULL DEFAULT '',
  zip           text NOT NULL DEFAULT '',
  cfdi_use      text NOT NULL DEFAULT '',
  invoice_email text NOT NULL DEFAULT '',
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_fiscal_updated_by_idx ON account_fiscal (updated_by);
