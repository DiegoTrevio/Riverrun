/** Fechas de calendario «AAAA-MM-DD» que llegan de afuera (panel, API). */
import { z } from 'zod';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha que existe: «2026-02-31» tiene el formato pero no existe (y la base la rechazaría con un error 500). */
export const isDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Esquema de una fecha de calendario, con el mensaje de formato de cada lugar. */
export const dateStr = (formatMessage = 'Fecha en formato AAAA-MM-DD') =>
  z.string().regex(DATE_RE, formatMessage).refine(isDate, 'Esa fecha no existe');
