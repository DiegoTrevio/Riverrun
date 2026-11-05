/**
 * Permiso de un uso del Copiloto (sin base de datos): solo abre las rutas que su herramienta declara, para esa persona,
 * esa sesión y esa acción, una sola vez y por poco tiempo; nunca abre cobro, la cuenta, tu perfil, llaves ni secretos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copilotGranted, grantable, liveGrants, mintCopilotGrant, revokeCopilotGrant } from '../src/identity/copilot-grant.js';
import { COPILOT_TOOLS } from '../src/copilot/tools/index.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ACTION = '22222222-2222-4222-8222-222222222222';
const SID = 'sesion-1';

/** Una petición como la que ve Fastify (lo único que el permiso revisa). */
const req = (token: string, o: Partial<{ method: string; url: string; user: string; sid: string; action: string }> = {}) => ({
  method: o.method ?? 'POST',
  routeOptions: { url: o.url ?? '/api/automations' },
  user: { id: o.user ?? USER },
  sessionId: o.sid ?? SID,
  headers: { 'x-copilot': '1', 'x-copilot-action': o.action ?? ACTION, 'x-copilot-grant': token },
}) as any;

test('permiso: abre la ruta declarada una sola vez, para esa persona, sesión y acción', () => {
  const token = mintCopilotGrant({ userId: USER, sessionId: SID, actionId: ACTION, routes: ['POST /api/automations'] });
  for (const bad of [
    req(token, { url: '/api/automations/:id', method: 'PUT' }), // otra ruta
    req(token, { user: '33333333-3333-4333-8333-333333333333' }), // otra persona
    req(token, { sid: 'otra-sesion' }),
    req(token, { action: '44444444-4444-4444-8444-444444444444' }),
    req('inventado'),
  ]) assert.equal(copilotGranted(bad), false);
  const r = req(token);
  assert.equal(copilotGranted(r), true);
  assert.equal(copilotGranted(r), true, 'la misma petición (varios ganchos) no gasta dos usos');
  assert.equal(copilotGranted(req(token)), false, 'una segunda petición ya no pasa');
  assert.equal(liveGrants(), 0, 'gastado, se borra');
});

test('permiso: se revoca y con varios usos alcanza solo para esos', () => {
  const token = mintCopilotGrant({ userId: USER, sessionId: SID, actionId: ACTION, routes: ['POST /api/automations'], uses: 2 });
  assert.equal(copilotGranted(req(token)), true);
  revokeCopilotGrant(token);
  assert.equal(copilotGranted(req(token)), false, 'revocado ya no sirve');
  const two = mintCopilotGrant({ userId: USER, sessionId: SID, actionId: ACTION, routes: ['POST /api/automations'], uses: 2 });
  assert.equal(copilotGranted(req(two)), true);
  assert.equal(copilotGranted(req(two)), true);
  assert.equal(copilotGranted(req(two)), false);
});

test('permiso: nunca abre cobro, la cuenta, tu perfil y seguridad, llaves, secretos, planes, marcas ni sistema', () => {
  for (const key of [
    'POST /api/billing/change', 'GET /api/account/export.zip', 'POST /api/account/transfer', 'PUT /api/me/password', 'POST /api/2fa/step-up',
    'POST /api/api-keys', 'GET /api/settings/secrets', 'POST /api/settings/rotate-secrets', 'POST /api/settings/rotate-webhook-secret',
    'POST /api/webhook-endpoints/:id/rotate-secret', 'POST /api/plans', 'POST /api/brands', 'PUT /api/system/zernio', 'PUT /api/ai-prices/:model',
    'DELETE /api/accounts/:id', 'POST /api/users/:id/2fa/reset',
  ]) {
    assert.equal(grantable(key), false, key);
    const token = mintCopilotGrant({ userId: USER, sessionId: SID, actionId: ACTION, routes: [key] });
    const [method, url] = key.split(' ');
    assert.equal(copilotGranted(req(token, { method, url })), false, `${key}: ni declarándola`);
    revokeCopilotGrant(token);
  }
  for (const key of ['POST /api/automations', 'PUT /api/users/:id', 'POST /api/invitations', 'DELETE /api/contacts/:id', 'PUT /api/accounts/:id']) assert.equal(grantable(key), true, key);
});

test('herramientas: las rutas que declaran para el código son rutas que el permiso puede abrir', () => {
  for (const t of COPILOT_TOOLS) {
    for (const key of t.grants ?? []) {
      assert.match(key, /^(GET|POST|PUT|PATCH|DELETE) \/api\//, `${t.name}: ${key}`);
      assert.ok(grantable(key), `${t.name}: ${key} no se puede abrir`);
    }
  }
});
