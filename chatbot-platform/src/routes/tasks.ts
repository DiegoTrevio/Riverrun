import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contactFor, conversationFor, HttpError, notFound } from '../access.js';
import * as store from '../store/index.js';
import type { ContactTask } from '../types.js';
import { parse } from './util.js';

type Viewer = Parameters<typeof contactFor>[0];
const DueOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha límite debe tener formato AAAA-MM-DD');
const Text = z.string().trim().min(1, 'Escribe el pendiente o la nota').max(1000, 'Máximo 1000 caracteres');

const TaskBody = z.object({
  kind: z.enum(['pendiente', 'nota']).default('pendiente'),
  body: Text,
  due_on: DueOn.nullable().optional(),
  conversation_id: z.string().uuid().nullable().optional(),
});
const TaskPatch = z.object({
  body: Text.optional(),
  status: z.enum(['abierta', 'hecha']).optional(),
  due_on: DueOn.nullable().optional(),
});

/** Pendientes y notas de cada contacto. Una tarea sigue el permiso de su contacto: quien no ve al contacto, no la ve. */
export async function taskRoutes(api: FastifyInstance) {
  const taskFor = async (user: Viewer, id: string): Promise<ContactTask> => {
    const task = await store.getContactTask(id);
    if (!task) throw notFound('Pendiente no encontrado');
    await contactFor(user, task.contact_id);
    return task;
  };

  api.get('/api/contacts/:id/tasks', async (req: any) => {
    const contact = await contactFor(req.user, req.params.id);
    return store.listContactTasks(contact.id);
  });

  api.post('/api/contacts/:id/tasks', async (req: any) => {
    const contact = await contactFor(req.user, req.params.id);
    const b = parse(TaskBody, req.body);
    if (b.kind === 'nota' && b.due_on) throw new HttpError(400, 'Las notas no tienen fecha límite');
    if (b.conversation_id && (await conversationFor(req.user, b.conversation_id)).contact_id !== contact.id) {
      throw new HttpError(400, 'La conversación no es de este contacto');
    }
    const id = await store.insertContactTask({
      account_id: contact.account_id,
      contact_id: contact.id,
      conversation_id: b.conversation_id ?? null,
      kind: b.kind,
      body: b.body,
      due_on: b.due_on ?? null,
      created_by: req.user.id,
      created_via: 'panel',
    });
    return store.getContactTask(id);
  });

  api.patch('/api/tasks/:id', async (req: any) => {
    const task = await taskFor(req.user, req.params.id);
    const b = parse(TaskPatch, req.body);
    if (task.kind === 'nota' && (b.status || b.due_on)) throw new HttpError(400, 'Las notas no se marcan como hechas ni tienen fecha límite');
    const patch: Parameters<typeof store.updateContactTask>[1] = {};
    if (b.body !== undefined) patch.body = b.body;
    if (b.due_on !== undefined) patch.due_on = b.due_on;
    if (b.status && b.status !== task.status) {
      patch.status = b.status;
      patch.done_at = b.status === 'hecha' ? new Date() : null;
      patch.done_by = b.status === 'hecha' ? req.user.id : null;
    }
    if (Object.keys(patch).length) await store.updateContactTask(task.id, patch);
    return store.getContactTask(task.id);
  });

  api.delete('/api/tasks/:id', async (req: any) => {
    const task = await taskFor(req.user, req.params.id);
    // Un agente borra solo lo que creó; el administrador, cualquiera.
    if (req.user.role === 'agent' && task.created_by !== req.user.id) throw new HttpError(403, 'Solo quien lo creó o un administrador puede borrarlo');
    await store.deleteContactTask(task.id);
    return { ok: true };
  });
}
