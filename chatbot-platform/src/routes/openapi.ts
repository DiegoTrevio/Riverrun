/**
 * Descripción OpenAPI 3.1 de la API v1 (para Postman, Insomnia, Zapier, Make y generadores de clientes) y la
 * documentación navegable que se genera de ella (/api/v1/docs). Incluye los webhooks: cada evento y su cuerpo.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { API_VERSION, EVENT_TYPES, RETRY_MINUTES } from '../integrations/webhooks.js';

type Schema = Record<string, unknown>;
const param = (name: string, where: 'path' | 'query', schema: Schema, description = '') => ({ name, in: where, required: where === 'path', schema, description });
const limit = param('limit', 'query', { type: 'integer', minimum: 1, maximum: 200, default: 50 });
const cursor = param('cursor', 'query', { type: 'string' }, 'El next_cursor de la página anterior, tal cual');
const updatedSince = param('updated_since', 'query', { type: 'string', format: 'date-time' }, 'Solo lo que cambió desde esta fecha (ISO 8601 con zona)');
const id = param('id', 'path', { type: 'string', format: 'uuid' });
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: Schema, example?: unknown) => ({ 'application/json': { schema, ...(example !== undefined ? { example } : {}) } });
const ok = (schema: Schema, description = 'Correcto') => ({ '200': { description, content: json(schema) } });
const page = (n: string) => ({ type: 'object', properties: { data: { type: 'array', items: ref(n) }, next_cursor: { type: ['string', 'null'], description: 'Para pedir la siguiente página; null si no hay más' } } });
const list = (n: string) => ({ type: 'object', properties: { data: { type: 'array', items: ref(n) } } });
const body = (schema: Schema, example?: unknown) => ({ required: true, content: json(schema, example) });
const errors = (...codes: string[]) => Object.fromEntries(codes.map((c) => [c, { $ref: `#/components/responses/E${c}` }]));
const read = (o: Schema) => ({ ...o, responses: { ...(o.responses as Schema), ...errors('401', '404', '429') } });
const write = (o: Schema) => ({
  ...o,
  parameters: [...((o.parameters as unknown[]) ?? []), { $ref: '#/components/parameters/IdempotencyKey' }],
  responses: { ...(o.responses as Schema), ...errors('400', '401', '402', '403', '404', '409', '429') },
});

const phone = { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'En cualquier formato: «+52 1 55 1234 5678», «0052…», «(55) 1234-5678». Con la zona horaria de México, a 10 dígitos se le pone la lada 52. Si ya existe en cualquiera de sus formas (52… o 521…), se usa ese contacto.', example: '+52 55 1234 5678' };
const channelId = { type: 'string', format: 'uuid', description: 'Opcional si tienes un solo WhatsApp (GET /channels). Con varios, indica cuál.' };
const dataValue = { oneOf: [{ type: 'string', maxLength: 500 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };

const CONTACT_EXAMPLE = { id: '6f1c…', name: 'Ana López', profile_name: 'Ana', phone: '5215512345678', channel: { id: '9b2e…', type: 'whatsapp', name: 'WhatsApp' }, tags: ['crm'], data: { correo: 'ana@ejemplo.com' }, notes: [], consent: { given: true, at: '2026-10-28T15:00:00.000Z', source: 'api' }, opted_out: false, created_at: '2026-10-28T15:00:00.000Z', updated_at: '2026-10-28T15:00:00.000Z' };

/** El cuerpo de un evento de webhook con sus datos. */
const eventSchema = (type: string, data: Schema) => ({
  type: 'object',
  required: ['id', 'type', 'api_version', 'created_at', 'account_id', 'origin', 'data'],
  properties: {
    id: { type: 'string', format: 'uuid', description: 'Id del evento: igual en cada reintento y reenvío. Úsalo para no procesarlo dos veces.' },
    type: { const: type },
    api_version: { const: API_VERSION },
    created_at: { type: 'string', format: 'date-time' },
    account_id: { type: 'string', format: 'uuid' },
    origin: { enum: ['api', 'riverrun'], description: '"api" si lo provocó una llamada de tu sistema a la API (para no responderle a tu propio cambio).' },
    test: { const: true, description: 'Solo en «Enviar prueba» del panel.' },
    data,
  },
});
const withContext = (extra: Record<string, Schema> = {}, required: string[] = []) => ({
  type: 'object',
  required: ['contact', 'conversation', ...required],
  properties: { contact: { oneOf: [ref('WebhookContact'), { type: 'null' }] }, conversation: { oneOf: [ref('WebhookConversation'), { type: 'null' }] }, ...extra },
});
const EVENT_DATA: Record<string, Schema> = {
  'contact.created': withContext(),
  'message.received': withContext({ message: { type: 'string' } }, ['message']),
  'contact.data_captured': withContext({ field: { type: 'string', description: 'Clave del dato (GET /contact-fields)' }, value: { type: ['string', 'null'] } }, ['field']),
  'contact.tag_added': withContext({ tag: { type: 'string' } }, ['tag']),
  'contact.opted_out': withContext(),
  'conversation.handoff': withContext(),
  'goal.completed': withContext(),
  'appointment.booked': withContext({ appointment: ref('Appointment') }, ['appointment']),
  'appointment.rescheduled': withContext({ appointment: ref('Appointment') }, ['appointment']),
  'appointment.cancelled': withContext({ appointment: ref('Appointment') }, ['appointment']),
  'payment.due': withContext({ receivable: ref('Receivable') }, ['receivable']),
  'payment.overdue': withContext({ receivable: ref('Receivable') }, ['receivable']),
  'payment.paid': withContext({ receivable: ref('Receivable') }, ['receivable']),
  'quote.sent': withContext({ quote: ref('Quote') }, ['quote']),
  'quote.accepted': withContext({ quote: ref('Quote') }, ['quote']),
  'quote.rejected': withContext({ quote: ref('Quote') }, ['quote']),
  'pipeline.stage_changed': withContext({ pipeline: { type: 'object', description: 'Pipeline, columna nueva y anterior, motivo y valor' } }, ['pipeline']),
  'conversation.sent': ref('ConversationExport'),
  ping: { type: 'object', properties: { message: { type: 'string' }, contact: ref('WebhookContact') } },
};

const ERRORS: Record<string, string> = {
  '400': 'Datos inválidos: revisa `fields` (qué campo y por qué)',
  '401': 'Falta la llave o es inválida (code: missing_key, invalid_key)',
  '402': 'La cuenta está en pausa por su plan: puede leer, no escribir (code: account_paused)',
  '403': 'La llave es de solo lectura o la cuenta está desactivada (code: read_only_key, account_inactive)',
  '404': 'No existe en tu cuenta, el id no tiene formato uuid o la ruta no existe (code: not_found, route_not_found)',
  '409': 'Conflicto: Idempotency-Key usada con otra petición, la primera sigue en curso o el registro ya no está pendiente',
  '429': 'Demasiadas solicitudes: espera lo que diga Retry-After (code: rate_limited)',
};

export function openApiSpec() {
  const base = `${config.publicBaseUrl}/api/v1`;
  return {
    openapi: '3.1.0',
    info: {
      title: 'Riverrun API v1',
      version: `1.${API_VERSION}.0`,
      description: [
        'Contactos, conversaciones, mensajes, cobros y citas de tu cuenta, y los webhooks que te avisan cuando algo pasa.',
        '',
        '**Empieza en 3 pasos:** crea una llave en Integraciones (Ajustes → Integraciones) · pon la dirección base y la llave en tu sistema · prueba `GET /me`.',
        '',
        '- **Autenticación:** `Authorization: Bearer rr_…`. Las llaves de solo lectura no pueden usar POST ni PUT.',
        '- **Límites:** 300 lecturas y 60 escrituras por minuto por llave (y 600 por minuto por conexión). Al pasarte: 429 con `Retry-After`.',
        '- **Errores:** siempre `{ "error", "code", "fields": [{ "field", "message" }], "issues" }`. `code` es estable: úsalo en tu programa; `error` es para personas.',
        '- **Reintentos seguros:** manda `Idempotency-Key` en POST y PUT. Si repites la petición (se cortó la red) recibes la misma respuesta (cabecera `idempotent-replayed: true`) sin crear ni enviar nada otra vez. Vale 24 h.',
        '- **Teléfonos:** en cualquier formato. **Canal:** si tienes un solo WhatsApp no hace falta `channel_id`.',
        '- **Paginación:** las listas traen `next_cursor`; pásalo en `cursor` para la siguiente página.',
        '- **Webhooks:** firmados con la cabecera `x-riverrun-signature: t=<segundos>,v1=<HMAC-SHA256 de "t.cuerpo">` y el secreto de Integraciones. Se reintentan 6 veces en unas 8 h; el mismo evento conserva su `id`.',
      ].join('\n'),
    },
    servers: [{ url: base }],
    security: [{ bearer: [] }],
    tags: [
      { name: 'Empezar', description: 'Tu cuenta, tus canales y los datos de tus clientes: de aquí salen los ids y las claves que piden las demás rutas.' },
      { name: 'Contactos', description: 'Clientes: alta o actualización por teléfono, datos, etiquetas, consentimiento y bajas.' },
      { name: 'Conversaciones y mensajes', description: 'Leer conversaciones y sus mensajes, exportarlas y enviar mensajes.' },
      { name: 'Cobros', description: 'Cobros con recordatorios por WhatsApp y pagos recurrentes. El dinero no pasa por la plataforma: tu equipo confirma los pagos.' },
      { name: 'Citas', description: 'Las citas agendadas por el asistente, el panel o la página de reservas.' },
      { name: 'Equipo', description: 'Personas del equipo, asignación de conversaciones y avisos internos.' },
    ],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'rr_… (créala en Ajustes → Integraciones)' } },
      parameters: {
        IdempotencyKey: { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Opcional. Un id único de la operación en tu sistema (p. ej. el folio). Repetir la petición con la misma llave devuelve la misma respuesta sin repetir la operación (24 h).' },
      },
      responses: Object.fromEntries(Object.entries(ERRORS).map(([c, d]) => [`E${c}`, { description: d, content: json(ref('Error')) }])),
      schemas: {
        Error: {
          type: 'object', required: ['error', 'code'],
          properties: {
            error: { type: 'string', description: 'Qué pasó, en español, para personas' },
            code: { type: 'string', description: 'Estable, para tu programa', examples: ['invalid_request', 'invalid_phone', 'channel_required', 'no_whatsapp_channel', 'invalid_channel', 'not_found', 'route_not_found', 'missing_key', 'invalid_key', 'read_only_key', 'account_paused', 'account_inactive', 'rate_limited', 'idempotency_conflict', 'idempotency_in_progress', 'invalid_idempotency_key', 'invalid_json', 'invalid_cursor', 'not_pending', 'receivables_disabled', 'nobody_available', 'invalid_user', 'internal_error'] },
            fields: { type: 'array', items: { type: 'object', properties: { field: { type: 'string', examples: ['phone', 'data.edad'] }, message: { type: 'string' } } } },
            issues: { type: 'array', items: { type: 'string' }, description: 'Lo mismo que fields, como texto (compatibilidad)' },
            channels: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } }, description: 'Con code channel_required: tus WhatsApp' },
          },
          example: { error: 'Datos inválidos: data.edad: «Edad» debe ser un número', code: 'invalid_request', fields: [{ field: 'data.edad', message: '«Edad» debe ser un número' }], issues: ['data.edad: «Edad» debe ser un número'] },
        },
        Channel: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, type: { type: 'string', examples: ['whatsapp', 'zernio', 'messenger', 'instagram', 'webchat', 'email'] }, name: { type: 'string' }, platform: { type: ['string', 'null'] }, active: { type: 'boolean' }, has_assistant: { type: 'boolean' }, contacts_by_phone: { type: 'boolean', description: 'Sirve para dar de alta contactos, cobros y mensajes por teléfono' }, default: { type: 'boolean', description: 'Se usa cuando no indicas channel_id' }, created_at: { type: 'string', format: 'date-time' } } },
        ContactField: { type: 'object', properties: { key: { type: 'string', description: 'La clave que va en data' }, label: { type: 'string' }, type: { enum: ['text', 'number', 'date', 'option', 'email', 'phone'] }, options: { type: 'array', items: { type: 'string' } } } },
        Contact: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' }, name: { type: ['string', 'null'] }, profile_name: { type: ['string', 'null'], description: 'El nombre de su perfil de WhatsApp' }, phone: { type: ['string', 'null'] },
            channel: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, type: { type: 'string' }, name: { type: 'string' } } },
            tags: { type: 'array', items: { type: 'string' } }, data: { type: 'object', additionalProperties: { type: 'string' }, description: 'Datos del cliente (siempre como texto; las fechas AAAA-MM-DD)' }, notes: { type: 'array', items: { type: 'string' } },
            consent: { type: 'object', properties: { given: { type: 'boolean' }, at: { type: ['string', 'null'], format: 'date-time' }, source: { type: ['string', 'null'] } } },
            opted_out: { type: 'boolean' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' },
          },
          example: CONTACT_EXAMPLE,
        },
        ContactPatch: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 100 },
            data: { type: 'object', additionalProperties: dataValue, description: 'Se combinan con los que ya tiene. Texto, número o sí/no; null o "" borran el dato. Los datos definidos (GET /contact-fields) se validan: fecha AAAA-MM-DD o DD/MM/AAAA, opción de la lista, correo o teléfono.' },
            tags: { type: 'array', items: { type: 'string', maxLength: 60 }, description: 'Reemplaza todas las etiquetas' },
            add_tags: { type: 'array', items: { type: 'string', maxLength: 60 } }, remove_tags: { type: 'array', items: { type: 'string', maxLength: 60 } },
            notes: { type: 'array', items: { type: 'string', maxLength: 300 } }, consent: { type: 'boolean' }, opted_out: { type: 'boolean' },
          },
        },
        Conversation: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { enum: ['bot', 'human', 'closed'] }, assigned_user_id: { type: ['string', 'null'] }, handoff_reason: { type: ['string', 'null'] }, summary: { type: ['string', 'null'] }, data: { type: 'object' }, contact_id: { type: 'string', format: 'uuid' }, channel: { type: 'object' }, created_at: { type: 'string', format: 'date-time' }, last_message_at: { type: 'string', format: 'date-time' } } },
        Message: { type: 'object', properties: { id: { type: 'integer' }, at: { type: 'string', format: 'date-time' }, direction: { enum: ['inbound', 'outbound'] }, sender: { enum: ['customer', 'bot', 'human', 'system'] }, type: { type: 'string' }, text: { type: 'string' } } },
        ConversationExport: {
          type: 'object',
          description: 'Lo mismo que llega en el evento conversation.sent (campo data).',
          properties: {
            content: { enum: ['summary', 'full', 'both'] }, reason: { type: ['string', 'null'] },
            trigger: { type: ['object', 'null'], description: 'Qué lo disparó: regla y evento (etiqueta, intención, objetivo…), envío manual o null.' },
            contact: ref('WebhookContact'), conversation: { type: 'object' },
            summary: { type: 'object', description: 'Con content summary o both.', properties: { text: { type: ['string', 'null'] }, analysis: { type: 'object' }, generated_at: { type: ['string', 'null'], format: 'date-time' }, stale: { type: 'boolean' }, warning: { type: ['string', 'null'] } } },
            transcript: { type: 'object', description: 'Con content full o both. Si truncated, van los mensajes más recientes; el resto se pide a /conversations/{id}/messages.', properties: { messages: { type: 'array', items: ref('Message') }, total: { type: 'integer' }, included: { type: 'integer' }, truncated: { type: 'boolean' }, more: { type: ['string', 'null'] } } },
          },
        },
        Receivable: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, contact_id: { type: ['string', 'null'], format: 'uuid' }, conversation_id: { type: ['string', 'null'], format: 'uuid' }, concept: { type: 'string' }, amount_cents: { type: 'integer', description: 'En centavos: 150000 = $1,500.00' }, currency: { type: 'string' }, due_date: { type: 'string', format: 'date' }, status: { enum: ['pending', 'paid', 'canceled'] }, paid_at: { type: ['string', 'null'], format: 'date-time' }, paid_note: { type: 'string' }, payment_link: { type: 'string' }, reference: { type: 'string' }, source: { type: 'string' }, source_id: { type: 'string' }, installment: { type: 'string' }, reminders: { type: ['array', 'null'], items: { type: 'integer' } }, reminders_sent: { type: 'integer' }, last_reminded_at: { type: ['string', 'null'], format: 'date-time' }, paused_until: { type: ['string', 'null'], format: 'date-time' }, created_at: { type: 'string', format: 'date-time' } } },
        ReceivablePlan: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, contact_id: { type: 'string', format: 'uuid' }, concept: { type: 'string' }, amount_cents: { type: 'integer' }, currency: { type: 'string' }, frequency: { enum: ['weekly', 'biweekly', 'monthly'] }, day: { type: 'integer', description: 'Mensual: día del mes (1-31). Semanal o quincenal: día de la semana (0 = domingo)' }, starts_on: { type: 'string', format: 'date' }, ends_on: { type: ['string', 'null'], format: 'date' }, max_payments: { type: ['integer', 'null'] }, payments_created: { type: 'integer' }, next_due: { type: ['string', 'null'], format: 'date' }, active: { type: 'boolean' } } },
        Appointment: { type: 'object', description: 'Todos los campos de la cita, tal como están guardados (los mismos que traía antes el webhook).', properties: { id: { type: 'string', format: 'uuid' }, account_id: { type: 'string', format: 'uuid' }, service_id: { type: ['string', 'null'] }, service_name: { type: 'string' }, kind: { type: 'string', examples: ['appointment', 'call'] }, status: { enum: ['confirmed', 'cancelled', 'completed', 'no_show'] }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, customer_name: { type: 'string' }, customer_phone: { type: 'string' }, customer_email: { type: ['string', 'null'] }, notes: { type: 'string' }, source: { type: 'string', examples: ['bot', 'panel', 'pagina'] }, contact_id: { type: ['string', 'null'] }, conversation_id: { type: ['string', 'null'] }, assigned_user_id: { type: ['string', 'null'] }, assigned_user_name: { type: ['string', 'null'] }, meeting_url: { type: ['string', 'null'] }, cancel_reason: { type: 'string' }, created_at: { type: 'string', format: 'date-time' }, updated_at: { type: 'string', format: 'date-time' } } },
        Quote: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, folio: { type: 'string' }, kind: { enum: ['approximate', 'final'] }, total: { type: 'string', description: 'Con formato, p. ej. "$1,500.00"' }, valid_until: { type: 'string', format: 'date' } } },
        WebhookContact: { type: 'object', description: 'El contacto en los webhooks (consent es sí/no; el detalle está en GET /contacts/{id}).', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, profile_name: { type: ['string', 'null'] }, phone: { type: 'string' }, channel: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' } } }, tags: { type: 'array', items: { type: 'string' } }, data: { type: 'object', additionalProperties: { type: 'string' } }, consent: { type: 'boolean' }, opted_out: { type: 'boolean' }, created_at: { type: ['string', 'null'], format: 'date-time' } } },
        WebhookConversation: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { enum: ['bot', 'human', 'closed'] }, handoff_reason: { type: ['string', 'null'] }, channel: { type: 'object' }, summary: { type: ['string', 'null'] }, analysis: { type: 'object', description: 'Intención, ánimo, interés, acuerdos y pendientes' }, data: { type: 'object' }, flow_step: { type: 'integer' }, goal_completed_at: { type: ['string', 'null'], format: 'date-time' }, url: { type: 'string', description: 'La conversación en el panel' } } },
      },
    },
    paths: {
      '/me': { get: read({ tags: ['Empezar'], summary: 'Prueba tu llave: cuenta, permiso, zona horaria y canal por omisión', responses: ok({ type: 'object', properties: { account: { type: 'object' }, key: { type: 'object' }, timezone: { type: 'string' }, default_channel_id: { type: ['string', 'null'] }, docs_url: { type: 'string' } } }) }) },
      '/channels': { get: read({ tags: ['Empezar'], summary: 'Tus canales: el id que piden channel_id', responses: ok(list('Channel')) }) },
      '/contact-fields': { get: read({ tags: ['Empezar'], summary: 'Los datos de tus clientes: la clave que va en data y qué valor acepta', responses: ok(list('ContactField')) }) },
      '/contacts': {
        get: read({ tags: ['Contactos'], summary: 'Lista contactos (paginado por cursor)', parameters: [limit, cursor, updatedSince, param('tag', 'query', { type: 'string' }), param('phone', 'query', { type: 'string' }, 'En cualquier formato; encuentra las dos formas de México (52… y 521…)'), param('channel_id', 'query', { type: 'string', format: 'uuid' })], responses: ok(page('Contact')) }),
        post: write({
          tags: ['Contactos'], summary: 'Da de alta o actualiza un cliente por teléfono', description: '201 si es nuevo, 200 si ya existía (en cualquier forma del número). Solo canales de WhatsApp.',
          requestBody: body({ allOf: [ref('ContactPatch'), { type: 'object', required: ['phone'], properties: { phone, channel_id: channelId } }] }, { phone: '+52 55 1234 5678', name: 'Ana López', data: { correo: 'ana@ejemplo.com' }, tags: ['crm'] }),
          responses: { '200': { description: 'Ya existía: se actualizó', content: json(ref('Contact')) }, '201': { description: 'Creado', content: json(ref('Contact')) } },
        }),
      },
      '/contacts/{id}': {
        get: read({ tags: ['Contactos'], summary: 'Un contacto', parameters: [id], responses: ok(ref('Contact')) }),
        put: write({ tags: ['Contactos'], summary: 'Actualiza un contacto', parameters: [id], requestBody: body(ref('ContactPatch'), { add_tags: ['vip'], data: { ciudad: 'Monterrey' } }), responses: ok(ref('Contact')) }),
      },
      '/conversations': { get: read({ tags: ['Conversaciones y mensajes'], summary: 'Lista conversaciones', parameters: [limit, cursor, updatedSince, param('status', 'query', { enum: ['bot', 'human', 'closed'] }), param('channel_id', 'query', { type: 'string', format: 'uuid' }), param('contact_id', 'query', { type: 'string', format: 'uuid' })], responses: ok(page('Conversation')) }) },
      '/conversations/{id}/messages': { get: read({ tags: ['Conversaciones y mensajes'], summary: 'Mensajes de una conversación', parameters: [id, param('after', 'query', { type: 'integer' }, 'id del último mensaje ya leído'), param('limit', 'query', { type: 'integer', maximum: 500, default: 100 })], responses: ok({ type: 'object', properties: { data: { type: 'array', items: ref('Message') }, next_after: { type: ['integer', 'null'] } } }) }) },
      '/conversations/{id}/export': { get: read({ tags: ['Conversaciones y mensajes'], summary: 'La conversación para tu app: resumen, completa o ambos', parameters: [id, param('content', 'query', { enum: ['summary', 'full', 'both'], default: 'both' }), param('refresh', 'query', { enum: ['true', 'false'], default: 'false' }, 'Actualiza antes el resumen si hay mensajes nuevos (usa IA)')], responses: ok(ref('ConversationExport')) }) },
      '/conversations/{id}/assign': { put: write({ tags: ['Equipo'], summary: 'Asigna una conversación a una persona, al siguiente por turnos ("next") o a nadie (null)', parameters: [id], requestBody: body({ type: 'object', required: ['user_id'], properties: { user_id: { oneOf: [{ type: 'string', format: 'uuid' }, { const: 'next' }, { type: 'null' }] } } }, { user_id: 'next' }), responses: ok({ type: 'object', properties: { ok: { type: 'boolean' }, assigned_user_id: { type: ['string', 'null'] } } }) }) },
      '/messages': {
        post: write({
          tags: ['Conversaciones y mensajes'], summary: 'Envía un mensaje de texto', description: 'A una conversación, a un contacto o por teléfono (se da de alta si no existe). Respeta bajas, la ventana de 24 h y el límite del plan: si no se puede enviar responde 422 con el motivo.',
          requestBody: body({ type: 'object', required: ['text'], properties: { conversation_id: { type: 'string', format: 'uuid' }, contact_id: { type: 'string', format: 'uuid' }, phone, channel_id: channelId, text: { type: 'string', maxLength: 4000 } }, description: 'Indica conversation_id, contact_id o phone.' }, { phone: '+52 55 1234 5678', text: 'Hola Ana, tu pedido va en camino' }),
          responses: { '200': { description: 'Enviado', content: json({ type: 'object', properties: { sent: { const: true }, reason: { type: 'null' }, conversation_id: { type: 'string' } } }) }, '422': { description: 'No se pudo enviar (code: not_sent; reason dice por qué)', content: json({ type: 'object', properties: { sent: { const: false }, reason: { type: 'string' }, code: { const: 'not_sent' }, conversation_id: { type: 'string' } } }) } },
        }),
      },
      '/team': { get: read({ tags: ['Equipo'], summary: 'Personas del equipo (para avisos y asignaciones)', responses: ok({ type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, email: { type: 'string' }, role: { enum: ['admin', 'agent'] }, available: { type: 'boolean' } } } } } }) }) },
      '/notifications': { post: write({ tags: ['Equipo'], summary: 'Envía un aviso interno al panel (a todos, a un rol, a personas o por turnos)', requestBody: body({ type: 'object', required: ['title'], properties: { title: { type: 'string' }, body: { type: 'string' }, link: { type: 'string', description: 'Ruta del panel, p. ej. #/conversations' }, user_ids: { type: 'array', items: { type: 'string', format: 'uuid' } }, roles: { type: 'array', items: { enum: ['admin', 'agent'] } }, round_robin: { type: 'boolean', description: 'Avisar solo a quien siga en el turno' } } }, { title: 'Pedido grande', body: 'Ana pidió 40 piezas', roles: ['admin'] }), responses: ok({ type: 'object' }) }) },
      '/receivables': {
        get: read({ tags: ['Cobros'], summary: 'Lista cobros a clientes', parameters: [param('status', 'query', { enum: ['pending', 'overdue', 'paid', 'canceled'] }), param('contact_id', 'query', { type: 'string', format: 'uuid' })], responses: ok({ type: 'object', properties: { data: { type: 'array', items: ref('Receivable') }, totals: { type: 'object' } } }) }),
        post: write({
          tags: ['Cobros'], summary: 'Registra un cobro y programa sus recordatorios por WhatsApp',
          requestBody: body({ type: 'object', required: ['concept', 'amount_cents', 'due_date'], description: 'Indica contact_id, o phone (se da de alta el cliente si no existe).', properties: { contact_id: { type: 'string', format: 'uuid' }, phone, channel_id: channelId, conversation_id: { type: 'string', format: 'uuid' }, concept: { type: 'string', maxLength: 200 }, amount_cents: { type: 'integer', minimum: 1, description: 'En centavos' }, currency: { type: 'string', default: 'MXN' }, due_date: { type: 'string', format: 'date' }, payment_link: { type: 'string', format: 'uri', description: 'https' }, reference: { type: 'string' }, source_id: { type: 'string', maxLength: 100, description: 'Tu folio: repetir el alta con el mismo folio devuelve el mismo cobro (200) en lugar de duplicarlo' }, reminders: { type: ['array', 'null'], items: { type: 'integer' }, description: 'Días respecto al vencimiento (negativo = antes); null = los de la cuenta' } } }, { phone: '+52 55 1234 5678', concept: 'Mensualidad de noviembre', amount_cents: 150000, due_date: '2026-11-05', source_id: 'F-1024' }),
          responses: { '200': { description: 'Ya existía un cobro con ese source_id', content: json(ref('Receivable')) }, '201': { description: 'Creado', content: json({ allOf: [ref('Receivable'), { type: 'object', properties: { reminders_scheduled: { type: 'integer' } } }] }) } },
        }),
      },
      '/receivables/{id}/paid': { post: write({ tags: ['Cobros'], summary: 'Marca un cobro como pagado (cancela sus recordatorios)', parameters: [id], requestBody: { content: json({ type: 'object', properties: { note: { type: 'string', maxLength: 500 } } }) }, responses: ok(ref('Receivable')) }) },
      '/receivables/{id}/cancel': { post: write({ tags: ['Cobros'], summary: 'Cancela un cobro', parameters: [id], requestBody: { content: json({ type: 'object', properties: { note: { type: 'string', maxLength: 500 } } }) }, responses: ok(ref('Receivable')) }) },
      '/receivable-plans': {
        get: read({ tags: ['Cobros'], summary: 'Lista pagos recurrentes', parameters: [param('contact_id', 'query', { type: 'string', format: 'uuid' })], responses: ok(list('ReceivablePlan')) }),
        post: write({ tags: ['Cobros'], summary: 'Registra un pago recurrente: unos días antes de cada vencimiento se crea su cobro con sus recordatorios', requestBody: body({ type: 'object', required: ['contact_id', 'concept', 'amount_cents', 'frequency', 'day', 'starts_on'], properties: { contact_id: { type: 'string', format: 'uuid' }, concept: { type: 'string', maxLength: 200 }, amount_cents: { type: 'integer', minimum: 1 }, currency: { type: 'string', default: 'MXN' }, frequency: { enum: ['weekly', 'biweekly', 'monthly'] }, day: { type: 'integer', minimum: 0, maximum: 31 }, starts_on: { type: 'string', format: 'date' }, ends_on: { type: ['string', 'null'], format: 'date' }, max_payments: { type: ['integer', 'null'], minimum: 1 }, payment_link: { type: 'string' }, reference: { type: 'string' } } }), responses: { '201': { description: 'Creado', content: json({ allOf: [ref('ReceivablePlan'), { type: 'object', properties: { receivables_created: { type: 'integer' } } }] }) } } }),
      },
      '/receivable-plans/{id}/deactivate': { post: write({ tags: ['Cobros'], summary: 'Desactiva un pago recurrente (los cobros ya creados se quedan)', parameters: [id], responses: ok(ref('ReceivablePlan')) }) },
      '/appointments': { get: read({ tags: ['Citas'], summary: 'Lista citas', parameters: [limit, param('from', 'query', { type: 'string', format: 'date-time' }), param('to', 'query', { type: 'string', format: 'date-time' }), param('status', 'query', { type: 'string' })], responses: ok(list('Appointment')) }) },
    },
    webhooks: Object.fromEntries(Object.entries(EVENT_TYPES).map(([type, label]) => [type, {
      post: {
        summary: label,
        description: `Llega a la dirección de tu webhook con las cabeceras x-riverrun-event, x-riverrun-delivery (el id del evento), x-riverrun-signature (t=…,v1=…) y x-signature. Responde 2xx en menos de 10 s; si no, se reintenta a los ${RETRY_MINUTES.join(', ')} minutos.`,
        requestBody: { content: json(eventSchema(type, EVENT_DATA[type] ?? { type: 'object' })) },
        responses: { '200': { description: 'Recibido' } },
      },
    }])),
  };
}

export async function openApiRoutes(app: FastifyInstance) {
  app.get('/api/v1/openapi.json', async (_req, reply) => reply.header('cache-control', 'public, max-age=300').send(openApiSpec()));
  // Documentación navegable (sin llave), generada de la especificación.
  app.get('/api/v1/docs', async (_req, reply) => reply.redirect('/api-docs.html'));
}
