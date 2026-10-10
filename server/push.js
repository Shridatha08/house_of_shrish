import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Push is optional: without credentials the server runs exactly as before.
let messaging = null;
let initError = null;

function loadCredential() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline) return JSON.parse(inline);
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (path) return require(path);
  return null;
}

function getMessaging() {
  if (messaging || initError) return messaging;
  try {
    const credential = loadCredential();
    if (!credential) {
      initError = new Error('No Firebase credentials configured.');
      return null;
    }
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(credential) });
    }
    messaging = admin.messaging();
  } catch (error) {
    initError = error;
    console.warn('[push] disabled:', error.message);
  }
  return messaging;
}

export function pushEnabled() {
  return Boolean(getMessaging());
}

function tokensFor(data, { userId = null, admin = false }) {
  return (data.deviceTokens || [])
    .filter((entry) => (admin ? entry.isAdmin : entry.userId === userId))
    .map((entry) => entry.token);
}

/**
 * Sends a notification and prunes tokens the device has invalidated.
 * Never throws — a push failure must not fail the request that triggered it.
 */
async function send(db, tokens, { title, body, data = {} }) {
  const client = getMessaging();
  if (!client || tokens.length === 0) return;

  const payload = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, String(value)])
  );

  try {
    const response = await client.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: payload,
      android: { priority: 'high', notification: { channelId: payload.channel || 'general' } }
    });

    const dead = new Set();
    response.responses.forEach((result, index) => {
      const code = result.error?.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-argument') {
        dead.add(tokens[index]);
      }
    });
    if (dead.size > 0) {
      db.data.deviceTokens = (db.data.deviceTokens || []).filter((entry) => !dead.has(entry.token));
      await db.write();
    }
  } catch (error) {
    console.warn('[push] send failed:', error.message);
  }
}

export async function notifyAdmins(db, message) {
  await send(db, tokensFor(db.data, { admin: true }), { ...message, data: { ...message.data, channel: 'admin' } });
}

export async function notifyUser(db, userId, message) {
  await send(db, tokensFor(db.data, { userId }), { ...message, data: { ...message.data, channel: 'orders' } });
}

export function registerDeviceToken(data, { token, userId = null, isAdmin = false, platform = 'android' }) {
  data.deviceTokens ||= [];
  // A device can switch accounts, so the token (not the user) is the identity.
  const existing = data.deviceTokens.find((entry) => entry.token === token);
  const record = { token, userId, isAdmin, platform, updatedAt: new Date().toISOString() };
  if (existing) Object.assign(existing, record);
  else data.deviceTokens.push(record);
}

export function removeDeviceToken(data, token) {
  data.deviceTokens = (data.deviceTokens || []).filter((entry) => entry.token !== token);
}
