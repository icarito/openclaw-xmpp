'use strict';

// Servicio HTTP de referencia que hace el envío real de push para los
// bridges de Prosody mod_fcm_push / mod_apns_push. Los módulos Lua solo
// forwardean el payload aquí por HTTP; este proceso sí habla con FCM (vía
// firebase-admin) y con APNs (vía @parse/node-apn).
//
// Sin framework: http nativo de Node. Rutas:
//   POST /push/fcm    -> Android (Firebase Cloud Messaging v1)
//   POST /push/apns   -> iOS (APNs)
//   GET  /health      -> liveness
//
// Ambas rutas exigen Authorization: Bearer <PUSH_SECRET>.

const http = require('http');
const fs = require('fs');

const PORT = Number.parseInt(process.env.PORT, 10) || 8787;
const PUSH_SECRET = process.env.PUSH_SECRET || '';
const MAX_BODY_BYTES = 64 * 1024;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`${name} no configurado`);
    err.statusCode = 500;
    throw err;
  }
  return value;
}

// ---------- FCM (firebase-admin) ----------

let fcmApp = null;
let fcmInitError = null;

function getFcmMessaging() {
  if (fcmApp) return fcmApp.messaging();
  if (fcmInitError) throw fcmInitError;
  try {
    const admin = require('firebase-admin');
    const serviceAccountPath = process.env.FCM_SERVICE_ACCOUNT;
    let credential;
    if (serviceAccountPath) {
      const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
      credential = admin.credential.cert(serviceAccount);
    } else {
      // Sin FCM_SERVICE_ACCOUNT usamos Application Default Credentials
      // (GOOGLE_APPLICATION_CREDENTIALS o el metadata server de GCP).
      credential = admin.credential.applicationDefault();
    }
    fcmApp = admin.initializeApp({ credential }, 'xat-push-sender');
    return fcmApp.messaging();
  } catch (err) {
    fcmInitError = err;
    throw err;
  }
}

// FCM exige que todos los valores de `data` sean strings.
function toStringMap(obj) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null) continue;
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  return out;
}

async function handleFcm(body) {
  const token = body.token;
  if (typeof token !== 'string' || token.length < 20) {
    const err = new Error('token FCM inválido');
    err.statusCode = 400;
    throw err;
  }

  const messaging = getFcmMessaging();
  const collapse = typeof body.collapse === 'string' && body.collapse ? body.collapse : undefined;
  const message = {
    token,
    notification: {
      title: body.title || 'Nuevo mensaje',
      body: body.body || '',
      // Notificación estable por conversación: Android reemplaza la anterior
      // en vez de apilar una por mensaje.
      ...(collapse ? { tag: collapse } : {}),
    },
    data: toStringMap(body.data),
    android: {
      priority: body.priority === 'high' ? 'high' : 'normal',
      ...(collapse ? { collapseKey: collapse } : {}),
      notification: {
        channelId: body.channelId || 'xmpp_messages',
        sound: 'default',
        ...(collapse ? { tag: collapse } : {}),
      },
    },
  };

  const messageId = await messaging.send(message);
  return { messageId };
}

// ---------- APNs (@parse/node-apn) ----------

let apnProvider = null;

function getApnProvider() {
  if (apnProvider) return apnProvider;
  const apn = require('@parse/node-apn');
  const keyFile = requireEnv('APNS_KEY_FILE');
  apnProvider = new apn.Provider({
    token: {
      key: fs.readFileSync(keyFile, 'utf8'),
      keyId: requireEnv('APNS_KEY_ID'),
      teamId: requireEnv('APNS_TEAM_ID'),
    },
    // Sandbox por defecto NO: APNS_PRODUCTION solamente se desactiva con "false".
    production: process.env.APNS_PRODUCTION !== 'false',
  });
  return apnProvider;
}

async function handleApns(body) {
  const token = body.token;
  if (typeof token !== 'string' || !/^[0-9a-fA-F]+$/.test(token)) {
    const err = new Error('token APNs inválido');
    err.statusCode = 400;
    throw err;
  }

  const apn = require('@parse/node-apn');
  const notification = new apn.Notification();
  notification.topic = requireEnv('APNS_TOPIC');
  notification.pushType = 'alert';
  notification.alert = {
    title: body.title || 'Nuevo mensaje',
    body: body.body || '',
  };
  notification.sound = (body.aps && body.aps.sound) || 'default';
  notification.priority = body.priority === 'high' ? 10 : 5;
  // Notificación estable por conversación: iOS agrupa por threadId y reemplaza
  // con el mismo collapseId en vez de apilar.
  const collapse = typeof body.collapse === 'string' && body.collapse ? body.collapse : undefined;
  if (collapse) {
    notification.threadId = collapse;
    notification.collapseId = collapse;
  }
  if (body.data && typeof body.data === 'object') {
    notification.payload = body.data;
  }

  const result = await getApnProvider().send(notification, token);
  if (result.failed && result.failed.length > 0) {
    const providerResponse = result.failed[0].response || {};
    const err = new Error(`APNs rechazó el envío: ${providerResponse.reason || 'desconocido'}`);
    err.statusCode = 400;
    err.providerResponse = providerResponse;
    throw err;
  }
  return { sent: result.sent ? result.sent.length : 0 };
}

// ---------- HTTP plumbing ----------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('body demasiado grande');
        err.statusCode = 400;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        err.statusCode = 400;
        err.message = 'JSON inválido';
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function authorized(req) {
  if (!PUSH_SECRET) return false;
  return (req.headers['authorization'] || '') === `Bearer ${PUSH_SECRET}`;
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && path === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'POST' || (path !== '/push/fcm' && path !== '/push/apns')) {
    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  if (!PUSH_SECRET) {
    return sendJson(res, 500, { ok: false, error: 'PUSH_SECRET no configurado en el servidor' });
  }

  if (!authorized(req)) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { ok: false, error: err.message });
  }

  try {
    const result = path === '/push/fcm' ? await handleFcm(body) : await handleApns(body);
    return sendJson(res, 200, { ok: true, result });
  } catch (err) {
    console.error(`[push-sender] ${path} error:`, err.message);
    return sendJson(res, err.statusCode || 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[push-sender] escuchando en :${PORT}`);
});

module.exports = { server };
