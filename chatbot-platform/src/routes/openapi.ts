/** Descripción OpenAPI 3.1 de la API v1 (para Postman, Zapier, Make, generadores de clientes…). */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

const param = (name: string, where: 'path' | 'query', schema: object, description = '') => ({ name, in: where, required: where === 'path', schema, description });
const limit = param('limit', 'query', { type: 'integer', minimum: 1, maximum: 200, default: 50 });
const cursor = param('cursor', 'query', { type: 'string' }, 'next_cursor de la página anterior');
const updatedSince = param('updated_since', 'query', { type: 'string', format: 'date-time' });
const id = param('id', 'path', { type: 'string', format: 'uuid' });
const ok = (schema: object) => ({ '200': { description: 'Correcto', content: { 'application/json': { schema } } } });
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const page = (n: string) => ({ type: 'object', properties: { data: { type: 'array', items: ref(n) }, next_cursor: { type: ['string', 'null'] } } });
const body = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });

export function openApiSpec() {
  return {
    openapi: '3.1.0',
    info: { title: 'Riverrun API v1', version: '1.0.0', description: 'Contactos, conversaciones, mensajes y citas de tu cuenta. Crea una llave en Ajustes → Integraciones. Límites: 300 lecturas y 60 escrituras por minuto por llave.' },
    servers: [{ url: `${config.publicBaseUrl}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'rr_… (llaves de solo lectura no pueden usar POST/PUT)' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } } },
        Contact: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, phone: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, data: { type: 'object', additionalProperties: { type: 'string' } }, consent: { type: 'boolean' }, opted_out: { type: 'boolean' } } },
        ContactPatch: { type: 'object', properties: { name: { type: 'string' }, data: { type: 'object', additionalProperties: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, add_tags: { type: 'array', items: { type: 'string' } }, remove_tags: { type: 'array', items: { type: 'string' } }, notes: { type: 'array', items: { type: 'string' } }, consent: { type: 'boolean' } } },
        Conversation: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { enum: ['bot', 'human', 'closed'] }, summary: { type: 'string' }, last_message_at: { type: 'string', format: 'date-time' } } },
        Message: { type: 'object', properties: { id: { type: 'integer' }, at: { type: 'string', format: 'date-time' }, direction: { enum: ['inbound', 'outbound'] }, sender: { type: 'string' }, type: { type: 'string' }, content: { type: 'string' } } },
        Appointment: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, service_name: { type: 'string' }, kind: { type: 'string' }, customer_name: { type: 'string' }, customer_phone: { type: 'string' }, starts_at: { type: 'string', format: 'date-time' }, ends_at: { type: 'string', format: 'date-time' }, status: { type: 'string' } } },
      },
    },
    paths: {
      '/me': { get: { summary: 'Cuenta y permiso de la llave', responses: ok({ type: 'object' }) } },
      '/contacts': {
        get: { summary: 'Lista contactos', parameters: [limit, cursor, updatedSince, param('tag', 'query', { type: 'string' }), param('phone', 'query', { type: 'string' }), param('channel_id', 'query', { type: 'string', format: 'uuid' })], responses: ok(page('Contact')) },
        post: { summary: 'Crea o actualiza un contacto por teléfono', requestBody: body({ allOf: [ref('ContactPatch'), { type: 'object', required: ['phone', 'channel_id'], properties: { phone: { type: 'string' }, channel_id: { type: 'string', format: 'uuid' } } }] }), responses: ok(ref('Contact')) },
      },
      '/contacts/{id}': {
        get: { summary: 'Un contacto', parameters: [id], responses: ok(ref('Contact')) },
        put: { summary: 'Actualiza un contacto', parameters: [id], requestBody: body(ref('ContactPatch')), responses: ok(ref('Contact')) },
      },
      '/conversations': { get: { summary: 'Lista conversaciones', parameters: [limit, cursor, updatedSince, param('status', 'query', { enum: ['bot', 'human', 'closed'] }), param('channel_id', 'query', { type: 'string', format: 'uuid' }), param('contact_id', 'query', { type: 'string', format: 'uuid' })], responses: ok(page('Conversation')) } },
      '/conversations/{id}/messages': { get: { summary: 'Mensajes de una conversación', parameters: [id, param('after', 'query', { type: 'integer' }, 'id del último mensaje ya leído'), param('limit', 'query', { type: 'integer', maximum: 500 })], responses: ok({ type: 'object', properties: { data: { type: 'array', items: ref('Message') } } }) } },
      '/messages': { post: { summary: 'Envía un texto (respeta bajas y el límite del plan)', requestBody: body({ type: 'object', required: ['text'], properties: { conversation_id: { type: 'string', format: 'uuid' }, channel_id: { type: 'string', format: 'uuid' }, phone: { type: 'string' }, text: { type: 'string', maxLength: 4000 } }, description: 'Indica conversation_id, o channel_id y phone.' }), responses: ok({ type: 'object' }) } },
      '/team': { get: { summary: 'Personas del equipo (para avisos y asignaciones)', responses: ok({ type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, email: { type: 'string' }, role: { enum: ['admin', 'agent'] }, available: { type: 'boolean' } } } } } }) } },
      '/notifications': { post: { summary: 'Envía un aviso interno al panel (a todos, a un rol, a personas o por turnos)', requestBody: body({ type: 'object', required: ['title'], properties: { title: { type: 'string' }, body: { type: 'string' }, link: { type: 'string', description: 'Ruta del panel, p. ej. #/conversations' }, user_ids: { type: 'array', items: { type: 'string', format: 'uuid' } }, roles: { type: 'array', items: { enum: ['admin', 'agent'] } }, round_robin: { type: 'boolean', description: 'Avisar solo a quien siga en el turno' } } }), responses: ok({ type: 'object' }) } },
      '/conversations/{id}/assign': { put: { summary: 'Asigna una conversación a una persona, al siguiente por turnos ("next") o a nadie (null)', parameters: [id], requestBody: body({ type: 'object', required: ['user_id'], properties: { user_id: { oneOf: [{ type: 'string', format: 'uuid' }, { const: 'next' }, { type: 'null' }] } } }), responses: ok({ type: 'object' }) } },
      '/appointments': { get: { summary: 'Lista citas', parameters: [limit, param('from', 'query', { type: 'string', format: 'date-time' }), param('to', 'query', { type: 'string', format: 'date-time' }), param('status', 'query', { type: 'string' })], responses: ok({ type: 'object', properties: { data: { type: 'array', items: ref('Appointment') } } }) } },
    },
  };
}

export async function openApiRoutes(app: FastifyInstance) {
  app.get('/api/v1/openapi.json', async (_req, reply) => reply.header('cache-control', 'public, max-age=300').send(openApiSpec()));
}
