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

/// Reports whether sending is possible and, when it is not, why. Without this
/// a bad credential is indistinguishable from "nobody has registered yet".
export function pushDiagnostics(data) {
  const ready = Boolean(getMessaging());
  const tokens = data.deviceTokens || [];
  return {
    enabled: ready,
    reason: ready ? null : (initError?.message || 'Unknown'),
    credentialSource: process.env.FIREBASE_SERVICE_ACCOUNT
      ? 'FIREBASE_SERVICE_ACCOUNT'
      : process.env.GOOGLE_APPLICATION_CREDENTIALS
        ? 'GOOGLE_APPLICATION_CREDENTIALS'
        : null,
    devices: {
      total: tokens.length,
      admin: tokens.filter((entry) => entry.isAdmin).length,
      customers: tokens.filter((entry) => !entry.isAdmin && entry.userId !== null && entry.userId !== undefined).length,
      guests: tokens.filter((entry) => !entry.isAdmin && (entry.userId === null || entry.userId === undefined)).length
    }
  };
}

function tokensFor(data, predicate) {
  return (data.deviceTokens || []).filter(predicate).map((entry) => entry.token);
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
  const tokens = tokensFor(db.data, (entry) => entry.isAdmin);
  await send(db, tokens, { ...message, data: { ...message.data, channel: 'admin' } });
}

export async function notifyUser(db, userId, message) {
  if (userId === null || userId === undefined) return;
  const tokens = tokensFor(db.data, (entry) => entry.userId === userId);
  await send(db, tokens, { ...message, data: { ...message.data, channel: 'orders' } });
}

/// Reaches the account that placed the order plus any guest device that
/// registered against it.
export async function notifyOrder(db, order, message) {
  const tokens = tokensFor(db.data, (entry) =>
    (order.userId !== null && order.userId !== undefined && entry.userId === order.userId) ||
    (entry.orderId !== null && entry.orderId !== undefined && entry.orderId === order.id)
  );
  await send(db, tokens, { ...message, data: { ...message.data, channel: 'orders' } });
}

/// Broadcast to every customer device.
export async function notifyAllCustomers(db, message) {
  const tokens = tokensFor(db.data, (entry) => !entry.isAdmin);
  await send(db, tokens, { ...message, data: { ...message.data, channel: 'orders' } });
  return tokens.length;
}

export function registerDeviceToken(data, { token, userId = null, orderId = null, isAdmin = false, platform = 'android' }) {
  data.deviceTokens ||= [];
  // A device can switch accounts, so the token (not the user) is the identity.
  const existing = data.deviceTokens.find((entry) => entry.token === token);
  const record = { token, userId, orderId, isAdmin, platform, updatedAt: new Date().toISOString() };
  if (existing) Object.assign(existing, record);
  else data.deviceTokens.push(record);
}

export function removeDeviceToken(data, token) {
  data.deviceTokens = (data.deviceTokens || []).filter((entry) => entry.token !== token);
}
