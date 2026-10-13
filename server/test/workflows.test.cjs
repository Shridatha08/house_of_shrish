const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
// Lives beside the kitchen, so meal orders are in range by default.
const customer = { name: 'Test Customer', phone: '9000000000', address: 'Test Street', flatNumber: 'A-12', pincode: '560075', lat: 12.9744, lng: 77.6743 };
const unpinnedCustomer = { name: 'Test Customer', phone: '9000000000', address: 'Test Street', flatNumber: 'A-12', pincode: '560075' };
const now = '2026-10-10T04:00:00Z';

function fixture() {
  return {
    revision: 0,
    users: [{ ...customer, id: 1, passwordHash: 'hashed:password' }],
    sessions: [{ userId: 1, token: 'user-token', createdAt: now }],
    orders: [], subscriptions: [], passwordResetRequests: [], holidays: [],
    settings: { subscriptionWorkingDays: 2, dailyOrderCapacity: 50, kitchenClosedDates: [], lunchCutoffTime: '11:00', dinnerCutoffTime: '18:30' },
    menu: [
      { id: 1, name: 'Single Meal', category: 'Pure Veg Meals', price: 129, customisations: ['Meal A', 'Meal B'] },
      { id: 2, name: 'Monthly (Lunch)', category: 'Pure Veg Meals', price: 3299, customisations: ['Meal A', 'Meal B'] },
      { id: 4, name: 'Monthly (Lunch + Dinner)', category: 'Pure Veg Meals', price: 5499, customisations: ['Meal A', 'Meal B'] },
      { id: 6, name: 'Dry Fruits Ladoo', category: 'Artisanal Sweets', price: 299, variants: [{ label: '200g', price: 299 }, { label: '500g', price: 699 }] }
    ]
  };
}

const RECORD_KEYS = {
  menu: 'id', orders: 'id', users: 'id', sessions: 'token', passwordResetRequests: 'id',
  subscriptions: 'id', holidays: 'id', drivers: 'id', driverSessions: 'token', deviceTokens: 'token'
};

// Applies only the records a snapshot actually changed, the way per-record
// collection writes do, and rejects a record another request already moved on.
function mergeRecords(current, base, next) {
  const result = structuredClone(current);
  for (const [name, key] of Object.entries(RECORD_KEYS)) {
    const before = new Map((base[name] || []).map((entry) => [entry[key], JSON.stringify(entry)]));
    const live = new Map((result[name] || []).map((entry) => [entry[key], entry]));
    const after = new Map((next[name] || []).map((entry) => [entry[key], entry]));

    for (const [id, entry] of after) {
      const wasJson = before.get(id);
      const nextJson = JSON.stringify(entry);
      if (wasJson === nextJson) continue;
      const liveEntry = live.get(id);
      const liveJson = liveEntry === undefined ? undefined : JSON.stringify(liveEntry);
      if (wasJson !== liveJson) throw Object.assign(new Error('Another update completed first. Please refresh and try again.'), { status: 409 });
      live.set(id, structuredClone(entry));
    }
    for (const id of before.keys()) if (!after.has(id)) live.delete(id);
    result[name] = [...live.values()];
  }
  if (JSON.stringify(base.settings) !== JSON.stringify(next.settings)) result.settings = structuredClone(next.settings);
  return result;
}

function application(data = fixture()) {  let state = structuredClone(data);
  let clock = new Date(now).getTime();
  const routes = new Map();
  const notifications = [];
  const snapshots = [];
  const app = { use() {}, set() {}, listen() {} };
  for (const method of ['get', 'post', 'patch', 'delete']) {
    app[method] = (route, ...handlers) => routes.set(`${method}:${route}`, handlers.at(-1));
  }
  const express = () => app;
  express.json = () => () => {};
  const context = {
    express, cors: () => () => {}, crypto, Buffer, structuredClone,
    process: { env: { ADMIN_KEY: 'test-admin' } }, console,
    // push.js is imported by index.js; the sandbox strips imports, so record instead of sending.
    notifyAdmins: async (db, message) => { notifications.push({ audience: 'admin', ...message }); },
    notifyUser: async (db, userId, message) => { notifications.push({ audience: 'user', userId, ...message }); },
    notifyOrder: async (db, order, message) => { notifications.push({ audience: 'order', orderId: order.id, userId: order.userId ?? null, ...message }); },
    registerDeviceToken: (data, record) => {
      data.deviceTokens ||= [];
      const existing = data.deviceTokens.find((entry) => entry.token === record.token);
      if (existing) Object.assign(existing, record);
      else data.deviceTokens.push({ userId: null, orderId: null, isAdmin: false, ...record });
    },
    notifyAllCustomers: async (db, message) => {
      const tokens = (db.data.deviceTokens || []).filter((entry) => !entry.isAdmin);
      notifications.push({ audience: 'promotion', recipients: tokens.length, ...message });
      return tokens.length;
    },
    pushDiagnostics: (data) => ({ enabled: false, reason: 'test', devices: { total: (data.deviceTokens || []).length } }),
    removeDeviceToken: (data, token) => {
      data.deviceTokens = (data.deviceTokens || []).filter((entry) => entry.token !== token);
    },
    bcrypt: { hash: async (password) => `hashed:${password}`, compare: async (password, hash) => hash === `hashed:${password}` },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    getDb: async () => {
      const base = structuredClone(state);
      const snapshot = structuredClone(state);
      // Mirrors the real adapter: a write lands record by record, so requests
      // touching different records do not overwrite each other.
      return { data: snapshot, write: async () => { state = mergeRecords(state, base, snapshot); } };
    },
    saveResetSnapshot: async (snapshot) => {
      snapshots.push(snapshot);
      return `reset-${snapshots.length}`;
    }
  };
  vm.createContext(context);
  vm.runInContext(source.replace(/^import .*;\r?$/gm, ''), context);
  return {
    context,
    state: () => state,
    notifications,
    snapshots,
    clock: (value) => { clock = new Date(value).getTime(); },
    async request(method, route, body = {}, params = {}, headers = { authorization: 'Bearer user-token' }) {
      const response = { code: 200, status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; }, end() { return this; } };
      try {
        await routes.get(`${method}:${route}`)({ body, params, headers }, response);
      } catch (error) {
        response.code = error.status || 500;
        response.body = { error: error.message };
      }
      return response;
    }
  };
}

async function purchase(app, itemId = 1, extra = {}) {
  return app.request('post', '/api/orders', {
    items: [{ id: itemId, quantity: 1, customisation: itemId === 6 ? '200g' : 'Meal A' }], customer, ...extra
  });
}

const adminHeaders = { 'x-admin-key': 'test-admin' };

test('login distinguishes unregistered users and incorrect passwords', async () => {
  const app = application();
  const missing = await app.request('post', '/api/auth/login', { phone: '9111111111', password: 'password' });
  assert.equal(missing.code, 401);
  assert.equal(missing.body.error, 'User not registered. Please register first.');
  const incorrect = await app.request('post', '/api/auth/login', { phone: customer.phone, password: 'wrong' });
  assert.equal(incorrect.code, 401);
  assert.equal(incorrect.body.error, 'Incorrect password. Please try again.');
  assert.equal(app.state().sessions.length, 1);
  const success = await app.request('post', '/api/auth/login', { phone: customer.phone, password: 'password' });
  assert.equal(success.code, 200);
  assert.ok(success.body.token);
});

test('registration and profile require, store, and return flat number and pincode', async () => {
  const app = application();
  const invalid = await app.request('post', '/api/auth/register', { ...customer, phone: '9111111111', pincode: '123', password: 'password' });
  assert.equal(invalid.code, 400);
  const registered = await app.request('post', '/api/auth/register', { ...customer, phone: '9111111111', password: 'password' });
  assert.equal(registered.code, 201);
  assert.equal(registered.body.user.flatNumber, 'A-12');
  assert.equal(registered.body.user.pincode, '560075');
  const updated = await app.request('patch', '/api/auth/profile', { ...customer, flatNumber: 'B-7' });
  assert.equal(updated.body.user.flatNumber, 'B-7');
});

test('customer payment submission requires admin verification before invoice and fulfillment', async () => {
  const app = application();
  const created = await purchase(app);
  assert.equal(created.code, 201);
  const id = created.body.order.id;
  const submitted = await app.request('patch', '/api/orders/:id/mark-paid', {}, { id });
  assert.equal(submitted.body.status, 'payment_review');
  assert.equal((await app.request('get', '/api/orders/:id/invoice', {}, { id })).code, 409);
  assert.equal((await app.request('patch', '/api/admin/orders/:id/status', { status: 'preparing' }, { id }, adminHeaders)).code, 409);
  assert.equal((await app.request('patch', '/api/admin/orders/:id/status', { status: 'paid' }, { id }, adminHeaders)).code, 200);
  const invoice = await app.request('get', '/api/orders/:id/invoice', {}, { id });
  assert.equal(invoice.code, 200);
  assert.equal(invoice.body.customer.pincode, '560075');
  assert.equal((await app.request('patch', '/api/admin/orders/:id/status', { status: 'preparing' }, { id }, adminHeaders)).code, 200);
  assert.equal((await app.request('patch', '/api/admin/orders/:id/status', { status: 'paid' }, { id }, adminHeaders)).code, 409);
});

test('guest order recovery requires its access token and returns the payment URI', async () => {
  const app = application();
  const created = await app.request('post', '/api/orders', { items: [{ id: 6, quantity: 1, customisation: '500g', price: 1 }], customer }, {}, {});
  const id = created.body.order.id;
  assert.equal(created.body.order.total, 699);
  assert.equal((await app.request('get', '/api/orders/:id', {}, { id }, {})).code, 403);
  const loaded = await app.request('get', '/api/orders/:id', {}, { id }, { 'x-order-token': created.body.accessToken });
  assert.equal(loaded.code, 200);
  assert.ok(loaded.body.upiUri.includes('am=699'));
  assert.equal(loaded.body.accessToken, undefined);
});

test('cancelled unpaid orders cannot request refunds or obtain invoices', async () => {
  const app = application();
  const created = await purchase(app);
  const id = created.body.order.id;
  assert.equal((await app.request('patch', '/api/orders/:id/cancel', {}, { id })).code, 200);
  assert.equal((await app.request('post', '/api/orders/:id/refund-request', {}, { id })).code, 409);
  assert.equal((await app.request('get', '/api/orders/:id/invoice', {}, { id })).code, 409);
});

test('paid cancellation preserves refund eligibility and disables the subscription', async () => {
  const app = application();
  const created = await purchase(app, 2, { subscriptionStartDate: '2026-10-12' });
  const id = created.body.order.id;
  const subId = app.state().subscriptions[0].id;
  assert.equal((await app.request('patch', '/api/admin/subscriptions/:id/approve', {}, { id: subId }, adminHeaders)).code, 409);
  await app.request('patch', '/api/orders/:id/mark-paid', {}, { id });
  await app.request('patch', '/api/admin/orders/:id/status', { status: 'paid' }, { id }, adminHeaders);
  assert.equal((await app.request('patch', '/api/admin/subscriptions/:id/approve', {}, { id: subId }, adminHeaders)).code, 200);
  await app.request('patch', '/api/orders/:id/cancel', {}, { id });
  assert.equal(app.state().subscriptions[0].deactivated, true);
  assert.equal((await app.request('get', '/api/subscriptions/me')).body.length, 0);
  assert.equal((await app.request('patch', '/api/admin/subscriptions/:id/approve', {}, { id: subId }, adminHeaders)).code, 409);
  assert.equal((await app.request('post', '/api/orders/:id/refund-request', {}, { id })).code, 200);
  assert.equal((await app.request('patch', '/api/admin/orders/:id/status', { status: 'refunded' }, { id }, adminHeaders)).code, 200);
});

test('monthly quantities are restricted; duplicate stock lines cannot bypass limits', async () => {
  const data = fixture();
  data.menu[0].dailyStock = 1;
  const app = application(data);
  assert.equal((await purchase(app, 2, { items: [{ id: 2, quantity: 2, customisation: 'Meal A' }] })).code, 400);
  const split = await purchase(app, 1, { items: [{ id: 1, quantity: 1, customisation: 'Meal A' }, { id: 1, quantity: 1, customisation: 'Meal B' }] });
  assert.equal(split.code, 409);
});

test('stock is calculated per item in IST and sold-out products are unavailable', async () => {
  const data = fixture();
  data.menu[0].dailyStock = 1;
  data.orders = [{ id: 10, createdAt: now, status: 'paid', items: [{ id: 6, quantity: 20 }] }];
  const app = application(data);
  let menu = await app.request('get', '/api/menu');
  assert.equal(menu.body.find((item) => item.id === 1).remainingStock, 1);
  await purchase(app);
  menu = await app.request('get', '/api/menu');
  assert.equal(menu.body.find((item) => item.id === 1).available, false);
});

test('kitchen capacity includes active subscription meals but excludes ladoo purchases', async () => {
  const data = fixture();
  data.settings.dailyOrderCapacity = 2;
  data.subscriptions = [{ id: 'offline', userId: 1, approved: true, itemName: 'Monthly (Lunch + Dinner)', startDate: '2026-10-10', workingDaysRequired: 2 }];
  const app = application(data);
  assert.equal((await purchase(app)).code, 409);
  assert.equal((await purchase(app, 6)).code, 201);
});

test('expired pending orders release stock and cannot submit payment', async () => {
  const data = fixture();
  data.menu[0].dailyStock = 1;
  data.orders = [{ id: 10, userId: 1, createdAt: '2026-10-10T03:00:00Z', status: 'pending_payment', items: [{ id: 1, quantity: 1 }] }];
  const app = application(data);
  assert.equal((await purchase(app)).code, 201);
  assert.equal((await app.request('patch', '/api/orders/:id/mark-paid', {}, { id: 10 })).code, 409);
});

test('closed dates, Sundays, and skips are excluded from subscription entitlements', () => {
  const data = fixture();
  data.settings.kitchenClosedDates = ['2026-10-12'];
  const app = application(data);
  const subscription = { startDate: '2026-10-10', workingDaysRequired: 1, itemName: 'Monthly (Lunch + Dinner)', skippedMeals: [{ date: '2026-10-10', meal: 'dinner' }] };
  const schedule = app.context.buildSubscriptionSchedule(subscription, app.context.subscriptionHolidays(data));
  assert.equal(schedule.endDate, '2026-10-13');
  assert.equal(schedule.schedule.at(-1).meal, 'lunch');
});

test('approval after lunch cutoff advances the first service', async () => {
  const app = application();
  const created = await purchase(app, 4);
  const id = created.body.order.id;
  await app.request('patch', '/api/orders/:id/mark-paid', {}, { id });
  await app.request('patch', '/api/admin/orders/:id/status', { status: 'paid' }, { id }, adminHeaders);
  app.clock('2026-10-10T06:00:00Z');
  const approved = await app.request('patch', '/api/admin/subscriptions/:id/approve', {}, { id: app.state().subscriptions[0].id }, adminHeaders);
  assert.equal(approved.body.startDate, '2026-10-11');
  assert.equal(approved.body.schedule[0].date, '2026-10-12');
});

test('reset keys are single-use, revoke sessions, and concurrent consumption cannot both succeed', async () => {
  const app = application();
  await app.request('post', '/api/auth/password-reset/request', { phone: customer.phone });
  const issued = await app.request('post', '/api/admin/password-reset-requests/:id/issue-key', {}, { id: app.state().passwordResetRequests[0].id }, adminHeaders);
  const payload = { phone: customer.phone, resetKey: issued.body.resetKey, password: 'new-password' };
  const results = await Promise.all([app.request('post', '/api/auth/password-reset/complete', payload), app.request('post', '/api/auth/password-reset/complete', payload)]);
  assert.equal(results.filter((result) => result.code === 204).length, 1);
  assert.equal(app.state().sessions.length, 0);
  assert.equal((await app.request('post', '/api/auth/password-reset/complete', payload)).code, 400);
  assert.equal(app.state().users[0].passwordHash, 'hashed:new-password');
});

test('expired sessions cannot access profiles; logout revokes current token', async () => {
  const app = application();
  app.clock('2026-12-01T04:00:00Z');
  assert.equal((await app.request('get', '/api/auth/me')).code, 401);
  assert.equal((await app.request('post', '/api/auth/logout')).code, 204);
  assert.equal(app.state().sessions.length, 0);
});

test('account deletion clears personal data but keeps orders on the books', async () => {
  const app = application();
  const created = await purchase(app);
  await app.request('post', '/api/device-token', { token: 'a'.repeat(32), platform: 'android' });
  await app.request('patch', '/api/orders/:id/cancel', {}, { id: created.body.order.id });

  assert.equal((await app.request('delete', '/api/auth/me')).code, 204);
  const state = app.state();
  assert.equal(state.users.length, 0);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.deviceTokens.length, 0);
  assert.equal(state.orders.length, 1);
  assert.equal(state.orders[0].userId, null);
  assert.equal(state.orders[0].customer.phone, '');
  assert.equal(state.orders[0].accessToken, undefined);
  assert.equal((await app.request('get', '/api/auth/me')).code, 401);
});

test('an order in progress blocks account deletion', async () => {
  const app = application();
  const created = await purchase(app);
  await app.request('patch', '/api/orders/:id/mark-paid', {}, { id: created.body.order.id });

  const blocked = await app.request('delete', '/api/auth/me');
  assert.equal(blocked.code, 409);
  assert.equal(app.state().users.length, 1);

  await app.request('patch', '/api/orders/:id/cancel', {}, { id: created.body.order.id });
  assert.equal((await app.request('delete', '/api/auth/me')).code, 204);
});

test('deletion requires a session', async () => {
  const app = application();
  assert.equal((await app.request('delete', '/api/auth/me', {}, {}, {})).code, 401);
  assert.equal(app.state().users.length, 1);
});

test('expired reset keys fail without changing a password', async () => {
  const app = application();
  await app.request('post', '/api/auth/password-reset/request', { phone: customer.phone });
  const issued = await app.request('post', '/api/admin/password-reset-requests/:id/issue-key', {}, { id: app.state().passwordResetRequests[0].id }, adminHeaders);
  app.clock('2026-10-10T04:31:00Z');
  const result = await app.request('post', '/api/auth/password-reset/complete', { phone: customer.phone, resetKey: issued.body.resetKey, password: 'new-password' });
  assert.equal(result.code, 400);
  assert.equal(app.state().users[0].passwordHash, 'hashed:password');
});

test('subscription skip enforces ownership, cutoff, and duplicate protection', async () => {
  const data = fixture();
  data.subscriptions = [{ id: 'offline', userId: 1, approved: true, itemName: 'Monthly (Lunch + Dinner)', startDate: '2026-10-10', workingDaysRequired: 2 }];
  const app = application(data);
  assert.equal((await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-10-10', meal: 'lunch' }, { id: 'offline' }, {})).code, 401);
  app.clock('2026-10-10T05:30:00Z');
  assert.equal((await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-10-10', meal: 'lunch' }, { id: 'offline' })).code, 409);
  assert.equal((await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-10-10', meal: 'dinner' }, { id: 'offline' })).code, 200);
  assert.equal((await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-10-10', meal: 'dinner' }, { id: 'offline' })).code, 409);
  assert.equal(app.state().subscriptions[0].skippedMeals.length, 1);
});

test('Single Meal lunch/dinner cutoffs remain IST while monthly/ladoo can order after hours', async () => {
  const app = application();
  app.clock('2026-10-10T05:29:00Z');
  assert.equal((await purchase(app)).body.order.mealService, 'lunch');
  app.clock('2026-10-10T05:30:00Z');
  assert.equal((await purchase(app)).body.order.mealService, 'dinner');
  app.clock('2026-10-10T13:00:00Z');
  assert.equal((await purchase(app)).code, 409);
  assert.equal((await purchase(app, 2)).code, 201);
  assert.equal((await purchase(app, 6)).code, 201);
});

test('future preferred start dates are stored, invalid/past dates rejected', async () => {
  const app = application();
  assert.equal((await purchase(app, 2, { subscriptionStartDate: '2026-99-99' })).code, 400);
  assert.equal((await purchase(app, 2, { subscriptionStartDate: '2026-10-09' })).code, 400);
  assert.equal((await purchase(app, 2, { subscriptionStartDate: '2026-11-01' })).code, 201);
  assert.equal(app.state().subscriptions[0].startDate, '2026-11-01');
});

test('existing monthly coverage permits only the missing meal', async () => {
  for (const [existingPlan, allowed, blocked] of [
    ['Monthly (Lunch)', [3], [2, 4]],
    ['Monthly (Dinner)', [2], [3, 4]],
    ['Monthly (Lunch + Dinner)', [], [2, 3, 4]]
  ]) {
    for (const itemId of [...allowed, ...blocked]) {
      const data = fixture();
      data.menu.push({ id: 3, name: 'Monthly (Dinner)', category: 'Pure Veg Meals', price: 3299, customisations: ['Meal A'] });
      data.subscriptions.push({ id: 'existing', userId: 1, approved: true, itemName: existingPlan, startDate: '2026-10-10', workingDaysRequired: 26 });
      const result = await purchase(application(data), itemId);
      assert.equal(result.code, allowed.includes(itemId) ? 201 : 409, `${existingPlan}: requested ${itemId}`);
    }
  }
});

test('pending monthly purchase blocks repeat coverage but cancellation or expiry releases it', async () => {
  const app = application();
  const created = await purchase(app, 2);
  assert.equal((await purchase(app, 2)).code, 409);
  await app.request('patch', '/api/orders/:id/cancel', {}, { id: created.body.order.id });
  assert.equal((await purchase(app, 2)).code, 201);
  app.clock('2026-10-10T04:31:00Z');
  assert.equal((await purchase(app, 2)).code, 201);
});

test('duplicate meal coverage inside one cart and manual enrollment are rejected', async () => {
  const app = application();
  const duplicate = await purchase(app, 2, { items: [
    { id: 2, quantity: 1, customisation: 'Meal A' },
    { id: 4, quantity: 1, customisation: 'Meal A' }
  ] });
  assert.equal(duplicate.code, 409);
  const manual = { userId: 1, itemId: 2, startDate: '2026-10-10' };
  assert.equal((await app.request('post', '/api/admin/subscriptions', manual, {}, adminHeaders)).code, 201);
  assert.equal((await app.request('post', '/api/admin/subscriptions', manual, {}, adminHeaders)).code, 409);
});

test('expired subscriptions do not block a new monthly purchase', async () => {
  const data = fixture();
  data.subscriptions.push({ id: 'old', userId: 1, approved: true, itemName: 'Monthly (Lunch + Dinner)', startDate: '2026-09-01', workingDaysRequired: 1 });
  assert.equal((await purchase(application(data), 4)).code, 201);
});

test('carry-forward deadline adds a calendar month to original end plus unique admin holidays', () => {
  const app = application();
  const deadline = app.context.subscriptionCarryForwardDeadline;
  assert.equal(deadline('2026-10-10', '2026-11-12', []), '2026-12-12');
  assert.equal(deadline('2026-10-10', '2026-11-12', [
    { date: '2026-11-10' }, { date: '2026-11-10' },
    { date: '2026-10-09' }, { date: '2026-12-20' }
  ]), '2026-12-13');
  assert.equal(deadline('2026-01-01', '2026-01-31', []), '2026-02-28');
  assert.equal(deadline('2028-01-01', '2028-01-31', []), '2028-02-29');
  assert.equal(deadline('2026-10-10', '2026-11-12', [
    { date: '2026-11-10' }, { date: '2026-12-13' }
  ]), '2026-12-14');
});

test('repeated skips cannot extend original end or schedule past the carry-forward deadline', () => {
  const app = application();
  const subscription = {
    startDate: '2026-10-10', workingDaysRequired: 2,
    itemName: 'Monthly (Lunch + Dinner)', skippedMeals: []
  };
  const base = app.context.buildSubscriptionSchedule(subscription, []);
  assert.equal(base.originalEndDate, '2026-10-12');
  assert.equal(base.carryForwardDeadline, '2026-11-12');
  const cursor = new Date('2026-10-10T00:00:00Z');
  while (cursor.toISOString().slice(0, 10) <= base.carryForwardDeadline) {
    const date = cursor.toISOString().slice(0, 10);
    for (const meal of ['lunch', 'dinner']) subscription.skippedMeals.push({ date, meal });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const capped = app.context.buildSubscriptionSchedule(subscription, []);
  assert.equal(capped.originalEndDate, base.originalEndDate);
  assert.equal(capped.carryForwardDeadline, base.carryForwardDeadline);
  assert.equal(capped.endDate, base.carryForwardDeadline);
  assert.equal(capped.mealsBeyondDeadline, 4);
  assert.equal(capped.remainingMeals, 0);
  assert.ok(capped.schedule.every((entry) => entry.date <= base.carryForwardDeadline));
  app.clock('2026-11-13T04:00:00Z');
  assert.equal(app.context.buildSubscriptionSchedule(subscription, []).expired, true);
});

test('skip beyond carry-forward deadline alerts with exact message and preserves the scheduled meal', async () => {
  const data = fixture();
  const skippedMeals = [];
  const cursor = new Date('2026-10-10T00:00:00Z');
  while (cursor.toISOString().slice(0, 10) < '2026-11-10') {
    if (cursor.getUTCDay() !== 0) skippedMeals.push({ date: cursor.toISOString().slice(0, 10), meal: 'lunch' });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  data.subscriptions = [{
    id: 'deadline', userId: 1, approved: true, itemName: 'Monthly (Lunch)',
    startDate: '2026-10-10', workingDaysRequired: 1, skippedMeals
  }];
  const app = application(data);
  const originalCount = skippedMeals.length;
  const response = await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-11-10', meal: 'lunch' }, { id: 'deadline' });
  assert.equal(response.code, 409);
  assert.equal(response.body.error, 'Cannot be carry forwarded beyond this date');
  assert.equal(app.state().subscriptions[0].skippedMeals.length, originalCount);
  assert.equal(app.state().revision, 0);
  const schedule = app.context.buildSubscriptionSchedule(app.state().subscriptions[0], []);
  assert.equal(schedule.schedule.at(-1).status, 'upcoming');
  const outside = await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-11-11', meal: 'lunch' }, { id: 'deadline' });
  assert.equal(outside.body.error, 'Cannot be carry forwarded beyond this date');
});

test('skip with remaining carry-forward room still succeeds', async () => {
  const data = fixture();
  data.subscriptions = [{ id: 'available', userId: 1, approved: true, itemName: 'Monthly (Lunch)', startDate: '2026-10-10', workingDaysRequired: 1 }];
  const app = application(data);
  const response = await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-10-10', meal: 'lunch' }, { id: 'available' });
  assert.equal(response.code, 200);
  assert.equal(response.body.endDate, '2026-10-12');
  assert.equal(response.body.mealsBeyondDeadline, 0);
});
test('a new order alerts admins, flagging subscriptions awaiting approval', async () => {
  const app = application();
  await app.request('post', '/api/orders', { items: [{ id: 1, quantity: 2, customisation: 'Meal A' }], customer });
  const [alert] = app.notifications;
  assert.equal(alert.audience, 'admin');
  assert.equal(alert.title, 'New order');
  assert.equal(alert.data.type, 'new_order');

  const withPlan = application();
  await withPlan.request('post', '/api/orders', { items: [{ id: 2, quantity: 1, customisation: 'Meal A' }], customer });
  assert.equal(withPlan.notifications[0].title, 'New subscription order');
  assert.equal(withPlan.notifications[0].data.type, 'new_subscription');
  assert.match(withPlan.notifications[0].body, /awaiting approval/);
});

test('only same-day skips alert admins', async () => {
  const data = fixture();
  data.subscriptions = [{ id: 'today', userId: 1, approved: true, itemName: 'Monthly (Lunch)', startDate: '2026-10-10', workingDaysRequired: 5 }];
  const app = application(data);

  await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-10-12', meal: 'lunch' }, { id: 'today' });
  assert.equal(app.notifications.length, 0, 'a future skip must not wake the kitchen');

  await app.request('post', '/api/subscriptions/:id/skip', { date: '2026-10-10', meal: 'lunch' }, { id: 'today' });
  assert.equal(app.notifications.length, 1);
  assert.equal(app.notifications[0].audience, 'admin');
  assert.equal(app.notifications[0].data.type, 'meal_skipped');
});

test('customers are told about approval, verified payment and delivery stages', async () => {
  const data = fixture();
  data.subscriptions = [{ id: 'pending', userId: 1, approved: false, itemName: 'Monthly (Lunch)', startDate: '2026-10-10', workingDaysRequired: 2 }];
  const app = application(data);

  await app.request('patch', '/api/admin/subscriptions/:id/approve', {}, { id: 'pending' }, { 'x-admin-key': 'test-admin' });
  assert.equal(app.notifications[0].audience, 'user');
  assert.equal(app.notifications[0].userId, 1);
  assert.equal(app.notifications[0].data.type, 'subscription_approved');

  const orders = application();
  await orders.request('post', '/api/orders', { items: [{ id: 1, quantity: 1, customisation: 'Meal A' }], customer });
  const orderId = orders.state().orders[0].id;
  await orders.request('patch', '/api/orders/:id/mark-paid', {}, { id: String(orderId) });

  const titles = [];
  for (const status of ['paid', 'preparing', 'out_for_delivery', 'delivered']) {
    await orders.request('patch', '/api/admin/orders/:id/status', { status }, { id: String(orderId) }, { 'x-admin-key': 'test-admin' });
    titles.push(orders.notifications.at(-1).title);
  }
  assert.deepEqual(titles, ['Payment confirmed', 'Order being prepared', 'Out for delivery', 'Delivered']);
  const statusAlerts = orders.notifications.filter((entry) => entry.data?.type === 'order_status');
  assert.equal(statusAlerts.length, 4);
  assert.ok(statusAlerts.every((entry) => entry.audience === 'order'));
});

test('device tokens register per audience and can be removed', async () => {
  const app = application();
  const token = 'a'.repeat(40);

  assert.equal((await app.request('post', '/api/device-token', { token: 'short' })).code, 400);
  assert.equal((await app.request('post', '/api/device-token', { token }, {}, {})).code, 401);

  await app.request('post', '/api/device-token', { token });
  assert.deepEqual(app.state().deviceTokens.map((entry) => [entry.userId, entry.isAdmin]), [[1, false]]);

  // Re-registering the same device must not duplicate it.
  await app.request('post', '/api/device-token', { token });
  assert.equal(app.state().deviceTokens.length, 1);

  const adminToken = 'b'.repeat(40);
  assert.equal((await app.request('post', '/api/admin/device-token', { token: adminToken }, {}, {})).code, 403);
  await app.request('post', '/api/admin/device-token', { token: adminToken }, {}, { 'x-admin-key': 'test-admin' });
  assert.equal(app.state().deviceTokens.filter((entry) => entry.isAdmin).length, 1);

  await app.request('delete', '/api/device-token', { token });
  assert.deepEqual(app.state().deviceTokens.map((entry) => entry.token), [adminToken]);
});

test('guests can register a device only with their own order token', async () => {
  const app = application();
  const token = 'g'.repeat(40);
  const placed = await app.request('post', '/api/orders', { items: [{ id: 1, quantity: 1, customisation: 'Meal A' }], customer }, {}, {});
  const { order, accessToken } = placed.body;

  // No session and no order token at all.
  assert.equal((await app.request('post', '/api/device-token', { token, orderId: order.id }, {}, {})).code, 401);
  // Correct order, wrong token.
  assert.equal((await app.request('post', '/api/device-token', { token, orderId: order.id }, {}, { 'x-order-token': 'wrong' })).code, 401);
  // Valid token but pointed at an order that does not exist.
  assert.equal((await app.request('post', '/api/device-token', { token, orderId: 999 }, {}, { 'x-order-token': accessToken })).code, 401);

  assert.equal((await app.request('post', '/api/device-token', { token, orderId: order.id }, {}, { 'x-order-token': accessToken })).code, 204);
  const [entry] = app.state().deviceTokens;
  assert.equal(entry.orderId, order.id);
  assert.equal(entry.userId, null);
});

test('guest orders notify the device bound to that order', async () => {
  const app = application();
  const placed = await app.request('post', '/api/orders', { items: [{ id: 1, quantity: 1, customisation: 'Meal A' }], customer }, {}, {});
  const { order, accessToken } = placed.body;
  await app.request('post', '/api/device-token', { token: 'g'.repeat(40), orderId: order.id }, {}, { 'x-order-token': accessToken });
  await app.request('patch', '/api/orders/:id/mark-paid', {}, { id: String(order.id) }, { 'x-order-token': accessToken });

  await app.request('patch', '/api/admin/orders/:id/status', { status: 'paid' }, { id: String(order.id) }, { 'x-admin-key': 'test-admin' });
  const update = app.notifications.at(-1);
  assert.equal(update.audience, 'order');
  assert.equal(update.orderId, order.id);
  assert.equal(update.userId, null, 'a guest order carries no account');
  assert.equal(update.title, 'Payment confirmed');
});

test('delivery coordinates are optional, validated, and preserved', async () => {
  const app = application();
  const account = { name: 'Geo', phone: '9123456780', password: 'secret1', address: 'Street', flatNumber: 'B-2', pincode: '560075' };

  assert.equal((await app.request('post', '/api/auth/register', { ...account, lat: 200, lng: 77 })).code, 400);

  const created = await app.request('post', '/api/auth/register', { ...account, lat: 12.97, lng: 77.59 });
  assert.equal(created.code, 201);
  assert.equal(created.body.user.lat, 12.97);
  assert.equal(created.body.user.lng, 77.59);

  // Registering without a pin is still allowed.
  const plain = await app.request('post', '/api/auth/register', { ...account, phone: '9123456781' });
  assert.equal(plain.code, 201);
  assert.equal(plain.body.user.lat, null);

  const token = created.body.token;
  const headers = { authorization: `Bearer ${token}` };
  const moved = await app.request('patch', '/api/auth/profile', { ...account, lat: 13.1, lng: 77.7 }, {}, headers);
  assert.equal(moved.body.user.lat, 13.1);

  // A profile save that omits coordinates must not wipe the saved pin.
  const kept = await app.request('patch', '/api/auth/profile', account, {}, headers);
  assert.equal(kept.body.user.lat, 13.1);
  assert.equal(kept.body.user.lng, 77.7);
});

test('submitting payment alerts admins to verify it', async () => {
  const app = application();
  await app.request('post', '/api/orders', { items: [{ id: 1, quantity: 1, customisation: 'Meal A' }], customer });
  const orderId = app.state().orders[0].id;
  const before = app.notifications.length;

  await app.request('patch', '/api/orders/:id/mark-paid', {}, { id: String(orderId) });
  const alert = app.notifications.at(-1);
  assert.equal(app.notifications.length, before + 1);
  assert.equal(alert.audience, 'admin');
  assert.equal(alert.title, 'Payment awaiting verification');
  assert.equal(alert.data.type, 'payment_review');

  // A rejected second submission must not alert again.
  await app.request('patch', '/api/orders/:id/mark-paid', {}, { id: String(orderId) });
  assert.equal(app.notifications.length, before + 1);
});

test('promotional broadcasts validate content and reach only customers', async () => {
  const app = application();
  const admin = { 'x-admin-key': 'test-admin' };

  assert.equal((await app.request('post', '/api/admin/broadcast', { title: 'Hi', body: 'There' }, {}, {})).code, 403);
  assert.equal((await app.request('post', '/api/admin/broadcast', { title: '', body: 'There' }, {}, admin)).code, 400);
  assert.equal((await app.request('post', '/api/admin/broadcast', { title: 'x'.repeat(61), body: 'There' }, {}, admin)).code, 400);
  assert.equal((await app.request('post', '/api/admin/broadcast', { title: 'Hi', body: 'y'.repeat(181) }, {}, admin)).code, 400);

  await app.request('post', '/api/device-token', { token: 'c'.repeat(40) });
  await app.request('post', '/api/admin/device-token', { token: 'a'.repeat(40) }, {}, admin);

  const sent = await app.request('post', '/api/admin/broadcast', { title: ' Weekend offer ', body: ' 20% off ladoos ' }, {}, admin);
  assert.equal(sent.code, 200);
  assert.equal(sent.body.recipients, 1, 'admin devices must not receive promotions');

  const promo = app.notifications.at(-1);
  assert.equal(promo.title, 'Weekend offer');
  assert.equal(promo.body, '20% off ladoos');
  assert.equal(promo.data.type, 'promotion');
});

test('meals are limited to the delivery radius; sweets are not', async () => {
  const app = application();
  const nearby = { ...customer, lat: 12.9744, lng: 77.6743 };           // at the kitchen
  const farAway = { ...customer, lat: 12.9716, lng: 77.5946 };          // ~9km away
  const meal = [{ id: 1, quantity: 1, customisation: 'Meal A' }];
  const ladoo = [{ id: 6, quantity: 1, customisation: '200g' }];

  const denied = await app.request('post', '/api/orders', { items: meal, customer: farAway }, {}, {});
  assert.equal(denied.code, 409);
  assert.equal(denied.body.error, 'Sorry Unavailable in your area. We are working to deliver soon!');

  assert.equal((await app.request('post', '/api/orders', { items: meal, customer: nearby }, {}, {})).code, 201);

  // Sweets ship anywhere, with or without a pin.
  assert.equal((await app.request('post', '/api/orders', { items: ladoo, customer: farAway }, {}, {})).code, 201);
  assert.equal((await app.request('post', '/api/orders', { items: ladoo, customer: unpinnedCustomer }, {}, {})).code, 201);

  // A meal without any pin cannot be range-checked, so it is refused.
  const unpinned = await app.request('post', '/api/orders', { items: meal, customer: unpinnedCustomer }, {}, {});
  assert.equal(unpinned.code, 400);
  assert.match(unpinned.body.error, /Pin your delivery location/);

  // A mixed cart is held to the stricter rule.
  const mixed = await app.request('post', '/api/orders', { items: [...meal, ...ladoo], customer: farAway }, {}, {});
  assert.equal(mixed.body.error, 'Sorry Unavailable in your area. We are working to deliver soon!');
});

function driverFixture() {
  const data = fixture();
  data.drivers = [{ id: 77, name: 'Ravi', phone: '9777777777', passwordHash: 'hashed:drive123', active: true }];
  data.driverSessions = [{ token: 'driver-token', driverId: 77, createdAt: now }];
  return data;
}
const driverAuth = { authorization: 'Bearer driver-token' };

test('drivers authenticate separately and cannot reach admin routes', async () => {
  const app = application(driverFixture());

  assert.equal((await app.request('get', '/api/driver/deliveries', {}, {}, {})).code, 401);
  assert.equal((await app.request('post', '/api/driver/login', { phone: '9777777777', password: 'wrong' })).code, 401);

  const session = await app.request('post', '/api/driver/login', { phone: '9777777777', password: 'drive123' });
  assert.equal(session.code, 200);
  assert.equal(session.body.driver.name, 'Ravi');
  assert.equal(session.body.driver.passwordHash, undefined);

  // A driver token must not unlock admin or customer surfaces.
  assert.equal((await app.request('get', '/api/admin/orders', {}, {}, driverAuth)).code, 403);
  assert.equal((await app.request('get', '/api/auth/me', {}, {}, driverAuth)).code, 401);
  assert.equal((await app.request('get', '/api/orders/me', {}, {}, driverAuth)).code, 401);
});

test('revoking a driver kills their session immediately', async () => {
  const app = application(driverFixture());
  assert.equal((await app.request('get', '/api/driver/deliveries', {}, {}, driverAuth)).code, 200);

  await app.request('delete', '/api/admin/drivers/:id', {}, { id: '77' }, { 'x-admin-key': 'test-admin' });
  assert.equal((await app.request('get', '/api/driver/deliveries', {}, {}, driverAuth)).code, 401);
});

test('the run covers paid orders and subscription meals, shortest route first', async () => {
  const data = driverFixture();
  // Two customers: one next to the kitchen, one further east.
  data.users = [
    { ...customer, id: 1, passwordHash: 'hashed:password', lat: 12.9744, lng: 77.6743 },
    { ...customer, id: 2, name: 'Far Customer', phone: '9000000002', passwordHash: 'x', lat: 12.9744, lng: 77.7000 }
  ];
  data.orders = [{
    id: 900, orderNumber: '#900', userId: 2, status: 'paid', paymentStatus: 'verified',
    createdAt: now, scheduledDate: '2026-10-10',
    items: [{ id: 1, name: 'Single Meal', price: 129, quantity: 1, customisation: 'Meal A' }],
    customer: { ...customer, name: 'Far Customer', lat: 12.9744, lng: 77.7000 }
  }];
  data.subscriptions = [{
    id: 'sub-near', userId: 1, approved: true, itemName: 'Monthly (Lunch)',
    startDate: '2026-10-10', workingDaysRequired: 5, skippedMeals: []
  }];

  const app = application(data);
  const run = await app.request('get', '/api/driver/deliveries', {}, {}, driverAuth);
  assert.equal(run.code, 200);
  assert.equal(run.body.stops.length, 2, 'orders and subscription meals both appear');

  // Nearest stop to the kitchen is sequenced first.
  assert.equal(run.body.stops[0].sequence, 1);
  assert.equal(run.body.stops[0].kind, 'subscription');
  assert.equal(run.body.stops[1].kind, 'order');
  assert.ok(run.body.stops[0].legKm < run.body.stops[1].legKm);
  assert.equal(run.body.stops[0].customerPhone, customer.phone);
});

test('completing a stop works for both orders and subscription meals', async () => {
  const data = driverFixture();
  data.users = [{ ...customer, id: 1, passwordHash: 'hashed:password', lat: 12.9744, lng: 77.6743 }];
  data.orders = [{
    id: 900, orderNumber: '#900', userId: 1, status: 'paid', paymentStatus: 'verified',
    createdAt: now, scheduledDate: '2026-10-10',
    items: [{ id: 1, name: 'Single Meal', price: 129, quantity: 1, customisation: 'Meal A' }],
    customer: { ...customer, lat: 12.9744, lng: 77.6743 }
  }];
  data.subscriptions = [{
    id: 'sub-1', userId: 1, approved: true, itemName: 'Monthly (Lunch)',
    startDate: '2026-10-10', workingDaysRequired: 5, skippedMeals: []
  }];
  const app = application(data);

  assert.equal((await app.request('post', '/api/driver/deliveries/:id/delivered', {}, { id: '900' }, driverAuth)).code, 204);
  assert.equal(app.state().orders[0].status, 'delivered');
  assert.equal(app.state().orders[0].deliveredBy, 77);

  assert.equal((await app.request('post', '/api/driver/deliveries/:id/delivered', {}, { id: 'sub-1:2026-10-10:lunch' }, driverAuth)).code, 204);
  assert.equal(app.state().subscriptions[0].deliveredMeals.length, 1);

  // Repeating a completed subscription meal must not duplicate it.
  await app.request('post', '/api/driver/deliveries/:id/delivered', {}, { id: 'sub-1:2026-10-10:lunch' }, driverAuth);
  assert.equal(app.state().subscriptions[0].deliveredMeals.length, 1);

  const run = await app.request('get', '/api/driver/deliveries', {}, {}, driverAuth);
  assert.ok(run.body.stops.every((stop) => stop.delivered), 'completed stops drop out of the pending route');
});

function trackingFixture(status = 'out_for_delivery') {
  const data = driverFixture();
  data.orders = [{
    id: 900, orderNumber: '900', userId: 1, status, paymentStatus: 'verified',
    createdAt: now, scheduledDate: '2026-10-10',
    items: [{ id: 1, name: 'Single Meal', price: 129, quantity: 1, customisation: 'Meal A' }],
    customer: { ...customer, lat: 12.9800, lng: 77.6800 }
  }];
  return data;
}

test('a driver position is only shared while the food is actually out', async () => {
  for (const status of ['paid', 'preparing', 'delivered']) {
    const app = application(trackingFixture(status));
    await app.request('post', '/api/driver/location', { lat: 12.9744, lng: 77.6743 }, {}, driverAuth);
    const tracked = await app.request('get', '/api/orders/:id/track', {}, { id: '900' });
    assert.equal(tracked.body.trackable, false, status);
    assert.equal(tracked.body.driver, null, status);
  }
});

test('tracking reports the driver, distance and an ETA', async () => {
  const app = application(trackingFixture());
  assert.equal((await app.request('post', '/api/driver/location', { lat: 12.9744, lng: 77.6743 }, {}, driverAuth)).code, 204);

  const tracked = await app.request('get', '/api/orders/:id/track', {}, { id: '900' });
  assert.equal(tracked.code, 200);
  assert.equal(tracked.body.trackable, true);
  assert.equal(tracked.body.driver.name, 'Ravi');
  assert.equal(tracked.body.driver.lat, 12.9744);
  assert.equal(tracked.body.driver.passwordHash, undefined);
  assert.equal(tracked.body.destination.lat, 12.98);
  assert.equal(tracked.body.destination.lng, 77.68);
  assert.equal(tracked.body.stopsAway, 0);
  assert.ok(tracked.body.distanceKm > 0 && tracked.body.distanceKm < 10);
  assert.ok(tracked.body.etaMinutes >= 1 && tracked.body.etaMinutes < 120);
});

test('an ETA accounts for the stops queued ahead of this one', async () => {
  const data = trackingFixture();
  // A nearer stop the driver will reach first.
  data.orders.push({
    id: 901, orderNumber: '901', userId: 2, status: 'paid', paymentStatus: 'verified',
    createdAt: now, scheduledDate: '2026-10-10',
    items: [{ id: 1, name: 'Single Meal', price: 129, quantity: 1, customisation: 'Meal A' }],
    customer: { ...customer, name: 'Nearer', lat: 12.9750, lng: 77.6750 }
  });
  const app = application(data);
  await app.request('post', '/api/driver/location', { lat: 12.9744, lng: 77.6743 }, {}, driverAuth);

  const tracked = await app.request('get', '/api/orders/:id/track', {}, { id: '900' });
  assert.equal(tracked.body.stopsAway, 1, 'one delivery happens before this one');

  const alone = application(trackingFixture());
  await alone.request('post', '/api/driver/location', { lat: 12.9744, lng: 77.6743 }, {}, driverAuth);
  const direct = await alone.request('get', '/api/orders/:id/track', {}, { id: '900' });
  assert.ok(tracked.body.etaMinutes > direct.body.etaMinutes, 'queued stops push the ETA out');
});

test('a stale fix is treated as offline rather than shown frozen', async () => {
  const app = application(trackingFixture());
  await app.request('post', '/api/driver/location', { lat: 12.9744, lng: 77.6743 }, {}, driverAuth);
  app.clock('2026-10-10T04:06:00Z');

  const tracked = await app.request('get', '/api/orders/:id/track', {}, { id: '900' });
  assert.equal(tracked.body.trackable, false);
  assert.equal(tracked.body.driver, null);
  assert.equal(tracked.body.etaMinutes, null);
});

test('tracking rejects strangers and bad coordinates', async () => {
  const app = application(trackingFixture());
  assert.equal((await app.request('get', '/api/orders/:id/track', {}, { id: '900' }, {})).code, 403);
  assert.equal((await app.request('post', '/api/driver/location', { lat: 12.9, lng: 77.6 }, {}, {})).code, 401);
  assert.equal((await app.request('post', '/api/driver/location', { lat: 999, lng: 77.6 }, {}, driverAuth)).code, 400);
  assert.equal((await app.request('post', '/api/driver/location', {}, {}, driverAuth)).code, 400);
});

test('a driver can stop sharing their position', async () => {
  const app = application(trackingFixture());
  await app.request('post', '/api/driver/location', { lat: 12.9744, lng: 77.6743 }, {}, driverAuth);
  assert.equal((await app.request('delete', '/api/driver/location', {}, {}, driverAuth)).code, 204);

  const tracked = await app.request('get', '/api/orders/:id/track', {}, { id: '900' });
  assert.equal(tracked.body.trackable, false);
});

test('position pings do not make concurrent orders fail with a stale write', async () => {
  const app = application(trackingFixture());

  // A ping and an order placed at the same moment touch different records, so
  // neither is rejected.
  const [ping, order] = await Promise.all([
    app.request('post', '/api/driver/location', { lat: 12.9744, lng: 77.6743 }, {}, driverAuth),
    purchase(app)
  ]);
  assert.equal(ping.code, 204);
  assert.equal(order.code, 201, order.body && order.body.error);

  // The driver app awaits each ping, so they arrive in sequence.
  for (let i = 0; i < 5; i++) {
    const sent = await app.request('post', '/api/driver/location', { lat: 12.9744 + i / 1000, lng: 77.6743 }, {}, driverAuth);
    assert.equal(sent.code, 204);
  }

  const tracked = await app.request('get', '/api/orders/:id/track', {}, { id: '900' });
  assert.equal(tracked.body.trackable, true);
});

test('unrelated writes no longer block each other', async () => {
  const app = application(trackingFixture());

  // Admin settings, a holiday and a customer order share no record between
  // them; under the single-document adapter any two of these would collide.
  const results = await Promise.all([
    app.request('patch', '/api/admin/settings', { subscriptionWorkingDays: 24, announcement: 'Festival menu' }, {}, adminHeaders),
    app.request('post', '/api/holidays', { date: '2026-12-31', name: 'Year end' }, {}, adminHeaders),
    purchase(app, 6),
    app.request('post', '/api/device-token', { token: 'b'.repeat(32), platform: 'android' })
  ]);

  assert.deepEqual(results.map((result) => result.code), [200, 201, 201, 204]);
  assert.equal(app.state().settings.announcement, 'Festival menu');
  assert.ok(app.state().holidays.some((entry) => entry.name === 'Year end'));
  assert.equal(app.state().orders.length, 2);
  assert.equal(app.state().deviceTokens.length, 1);
});

test('unpaid orders cannot pile up and exhaust the kitchen', async () => {
  const app = application();
  for (let i = 0; i < 3; i++) assert.equal((await purchase(app)).code, 201, `order ${i + 1}`);

  const refused = await purchase(app);
  assert.equal(refused.code, 429);
  assert.match(refused.body.error, /awaiting payment/);

  // Clearing one frees the slot it was holding.
  await app.request('patch', '/api/orders/:id/cancel', {}, { id: app.state().orders[0].id });
  assert.equal((await purchase(app)).code, 201);
});

test('submitted payment still counts, but a settled order does not', async () => {
  const app = application();
  const first = await purchase(app);
  await purchase(app);
  await purchase(app);

  // Claiming payment is not proof of it, so the order keeps holding its slot.
  await app.request('patch', '/api/orders/:id/mark-paid', {}, { id: first.body.order.id });
  assert.equal((await purchase(app)).code, 429);

  // Once the admin verifies it, the customer is no longer holding anything.
  await app.request('patch', '/api/admin/orders/:id/status', { status: 'paid' }, { id: first.body.order.id }, adminHeaders);
  assert.equal((await purchase(app)).code, 201);
});

test('an abandoned order stops blocking once it expires', async () => {
  const app = application();
  for (let i = 0; i < 3; i++) await purchase(app);
  assert.equal((await purchase(app)).code, 429);

  app.clock('2026-10-10T04:31:00Z');
  assert.equal((await purchase(app)).code, 201, 'expired orders release their hold');
});

test('one customer cannot block another', async () => {
  const app = application();
  const guest = (phone) => app.request('post', '/api/orders', {
    items: [{ id: 6, quantity: 1, customisation: '200g' }], customer: { ...customer, phone }
  }, {}, {});

  for (let i = 0; i < 3; i++) assert.equal((await guest('9111111111')).code, 201);
  assert.equal((await guest('9111111111')).code, 429);

  assert.equal((await guest('9222222222')).code, 201, 'a different guest is unaffected');
  assert.equal((await purchase(app)).code, 201, 'and so is a signed-in customer');
});

function populated() {
  const data = driverFixture();
  data.orders = [{
    id: 900, orderNumber: '900', userId: 1, status: 'delivered', paymentStatus: 'verified',
    createdAt: now, items: [{ id: 1, name: 'Single Meal', price: 129, quantity: 1, customisation: 'Meal A' }],
    customer: { ...customer }
  }];
  data.subscriptions = [{ id: 'sub-1', userId: 1, approved: true, itemName: 'Monthly (Lunch)', startDate: '2026-10-10', workingDaysRequired: 5, skippedMeals: [] }];
  data.deviceTokens = [
    { token: 'c'.repeat(32), userId: 1, isAdmin: false },
    { token: 'd'.repeat(32), isAdmin: true }
  ];
  return data;
}

test('the admin data reset clears history but keeps the menu and settings', async () => {
  const app = application(populated());
  const before = app.state();
  assert.ok(before.orders.length > 0 && before.users.length > 0);

  const wiped = await app.request('post', '/api/admin/reset', { confirm: 'ERASE' }, {}, adminHeaders);
  assert.equal(wiped.code, 200);
  assert.equal(wiped.body.orders, 1);
  assert.equal(wiped.body.users, 1);
  assert.equal(wiped.body.drivers, 1);

  const after = app.state();
  assert.equal(after.orders.length, 0);
  assert.equal(after.subscriptions.length, 0);
  assert.equal(after.users.length, 0);
  assert.equal(after.sessions.length, 0);
  assert.equal(after.drivers.length, 0);
  assert.equal(after.driverSessions.length, 0);

  // Configuration is not data and must survive.
  assert.equal(after.menu.length, before.menu.length);
  assert.equal(after.settings.subscriptionWorkingDays, before.settings.subscriptionWorkingDays);
  assert.equal(after.holidays.length, before.holidays.length);
});

test('a reset keeps the admin console subscribed to notifications', async () => {
  const app = application(populated());
  await app.request('post', '/api/admin/reset', { confirm: 'ERASE' }, {}, adminHeaders);

  const tokens = app.state().deviceTokens;
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].isAdmin, true, 'customer tokens go, the admin device stays');
});

test('a reset snapshots what it is about to destroy', async () => {
  const app = application(populated());
  const wiped = await app.request('post', '/api/admin/reset', { confirm: 'ERASE' }, {}, adminHeaders);

  assert.match(wiped.body.snapshotId, /^reset-/);
  assert.equal(app.snapshots.length, 1);
  assert.equal(app.snapshots[0].orders.length, 1);
  assert.equal(app.snapshots[0].users.length, 1);
  assert.equal(app.snapshots[0].drivers.length, 1);
});

test('a reset needs the admin key and the typed confirmation', async () => {
  const app = application(populated());

  assert.equal((await app.request('post', '/api/admin/reset', { confirm: 'ERASE' }, {}, {})).code, 403);
  assert.equal((await app.request('post', '/api/admin/reset', {}, {}, adminHeaders)).code, 400);
  assert.equal((await app.request('post', '/api/admin/reset', { confirm: 'erase' }, {}, adminHeaders)).code, 400);
  assert.equal((await app.request('post', '/api/admin/reset', { confirm: 'yes' }, {}, adminHeaders)).code, 400);

  // Nothing was touched by any of the rejected attempts.
  assert.equal(app.state().orders.length, 1);
  assert.equal(app.state().users.length, 1);
  assert.equal(app.snapshots.length, 0);
});

function subscriptionFixture() {
  const data = fixture();
  data.subscriptions = [{
    id: 'sub-eshwar', userId: 1, approved: true, itemName: 'Monthly (Lunch + Dinner)',
    startDate: '2026-10-10', workingDaysRequired: 26, skippedMeals: [], customisation: 'Meal A'
  }];
  return data;
}

test('the kitchen can write off a meal the customer never received', async () => {
  const app = application(subscriptionFixture());
  // 10 Oct 2026 is a Saturday, so both meals were scheduled that day.
  const before = await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders);
  const day = before.body[0].schedule.filter((entry) => entry.date === '2026-10-10');
  assert.equal(day.map((entry) => entry.meal).join(','), 'lunch,dinner');

  for (const meal of ['lunch', 'dinner']) {
    const result = await app.request('post', '/api/admin/subscriptions/:id/meal',
      { date: '2026-10-10', meal, skipped: true }, { id: 'sub-eshwar' }, adminHeaders);
    assert.equal(result.code, 200);
  }

  const after = await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders);
  const corrected = after.body[0];
  assert.equal(
    corrected.schedule.filter((e) => e.date === '2026-10-10').map((e) => e.status).join(','),
    'skipped,skipped'
  );
  // Nothing is lost: the meals move to the end instead.
  assert.ok(corrected.endDate > before.body[0].endDate, 'the subscription runs longer');
  assert.equal(corrected.remainingMeals, before.body[0].remainingMeals);
});

test('a written-off meal can be restored', async () => {
  const app = application(subscriptionFixture());
  await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'dinner', skipped: true }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(app.state().subscriptions[0].skippedMeals.length, 1);

  await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'dinner', skipped: false }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(app.state().subscriptions[0].skippedMeals.length, 0);
});

test('marking the same meal twice does not double count it', async () => {
  const app = application(subscriptionFixture());
  for (let i = 0; i < 3; i++) {
    await app.request('post', '/api/admin/subscriptions/:id/meal',
      { date: '2026-10-10', meal: 'lunch', skipped: true }, { id: 'sub-eshwar' }, adminHeaders);
  }
  assert.equal(app.state().subscriptions[0].skippedMeals.length, 1);
});

test('meal corrections are validated and admin-only', async () => {
  const app = application(subscriptionFixture());
  const call = (body, headers = adminHeaders) =>
    app.request('post', '/api/admin/subscriptions/:id/meal', body, { id: 'sub-eshwar' }, headers);

  assert.equal((await call({ date: '2026-10-10', meal: 'lunch', skipped: true }, {})).code, 403);
  assert.equal((await call({ date: 'nonsense', meal: 'lunch', skipped: true })).code, 400);
  assert.equal((await call({ date: '2026-10-10', meal: 'brunch', skipped: true })).code, 400);
  assert.equal((await call({ date: '2026-10-10', meal: 'lunch' })).code, 400);
  // Before the subscription even began.
  assert.equal((await call({ date: '2026-10-01', meal: 'lunch', skipped: true })).code, 400);
  assert.equal(app.state().subscriptions[0].skippedMeals.length, 0);
});

test('entitlement is counted in meals, so a subscription can end mid-day', async () => {
  const data = subscriptionFixture();
  data.subscriptions[0].workingDaysRequired = 3; // 6 meals for lunch + dinner
  const app = application(data);

  const full = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  const lastDay = full.schedule.filter((entry) => entry.date === full.endDate);
  assert.equal(lastDay.length, 2, 'an even entitlement ends on a whole day');

  // Writing off a single meal leaves an odd number to serve.
  await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'dinner', skipped: true }, { id: 'sub-eshwar' }, adminHeaders);

  const odd = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  const served = odd.schedule.filter((entry) => entry.status !== 'skipped');
  assert.equal(served.length, 6, 'still six meals owed');

  const finalDay = odd.schedule.filter((entry) => entry.date === odd.endDate && entry.status !== 'skipped');
  assert.equal(finalDay.length, 1, 'the last day carries a single meal');
  assert.equal(finalDay[0].meal, 'lunch', 'and it is the first slot of that day');
});

test('a delivered meal stops counting as still owed', async () => {
  const data = subscriptionFixture();
  data.subscriptions[0].workingDaysRequired = 3;
  const app = application(data);
  const driverData = app.state();
  assert.ok(driverData);

  const before = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  assert.equal(before.remainingMeals, 6);

  // The driver hands over both of today's meals.
  const today = '2026-10-10';
  app.state().subscriptions[0].deliveredMeals = [
    { date: today, meal: 'lunch', deliveredAt: now },
    { date: today, meal: 'dinner', deliveredAt: now }
  ];

  const after = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  assert.equal(after.remainingMeals, 4, 'delivered meals are no longer outstanding');

  const todayEntries = after.schedule.filter((entry) => entry.date === today);
  assert.equal(todayEntries.map((entry) => entry.status).join(','), 'delivered,delivered');
  assert.equal(todayEntries.every((entry) => entry.canCancel === false), true, 'a delivered meal cannot be skipped');
});

test('delivered meals still consume entitlement rather than extending it', async () => {
  const data = subscriptionFixture();
  data.subscriptions[0].workingDaysRequired = 3;
  data.subscriptions[0].deliveredMeals = [{ date: '2026-10-10', meal: 'lunch', deliveredAt: now }];
  const app = application(data);

  const sub = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  assert.equal(sub.schedule.filter((entry) => entry.status !== 'skipped').length, 6);
  assert.equal(sub.remainingMeals, 5);
  // Unlike a skip, a delivery must not push the end date out.
  const untouched = application(subscriptionFixture());
  untouched.state().subscriptions[0].workingDaysRequired = 3;
  const baseline = (await untouched.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  assert.equal(sub.endDate, baseline.endDate);
});

test('the kitchen can record a delivery the driver did not log', async () => {
  const data = subscriptionFixture();
  data.subscriptions[0].workingDaysRequired = 3;
  const app = application(data);

  const result = await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'lunch', status: 'delivered' }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(result.code, 200);
  assert.equal(app.state().subscriptions[0].deliveredMeals.length, 1);

  const sub = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  assert.equal(sub.schedule.find((e) => e.date === '2026-10-10' && e.meal === 'lunch').status, 'delivered');
  assert.equal(sub.remainingMeals, 5, 'one fewer meal owed');
});

test('a meal moves cleanly between delivered, skipped and pending', async () => {
  const app = application(subscriptionFixture());
  const set = (status) => app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'dinner', status }, { id: 'sub-eshwar' }, adminHeaders);
  const state = () => app.state().subscriptions[0];

  await set('skipped');
  assert.equal(state().skippedMeals.length, 1);
  assert.equal((state().deliveredMeals || []).length, 0);

  // Switching must not leave the meal recorded in both places.
  await set('delivered');
  assert.equal(state().skippedMeals.length, 0);
  assert.equal(state().deliveredMeals.length, 1);

  await set('pending');
  assert.equal(state().skippedMeals.length, 0);
  assert.equal(state().deliveredMeals.length, 0);
});

test('a meal cannot be marked delivered before it happens', async () => {
  const app = application(subscriptionFixture());
  const future = await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-11-30', meal: 'lunch', status: 'delivered' }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(future.code, 400);
  assert.match(future.body.error, /cannot be marked delivered/);
  assert.equal((app.state().subscriptions[0].deliveredMeals || []).length, 0);

  // Writing one off ahead of time is fine; the customer may have told us.
  const skip = await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-11-30', meal: 'lunch', status: 'skipped' }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(skip.code, 200);
});

test('the older skipped flag still works for installed admin builds', async () => {
  const app = application(subscriptionFixture());
  await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'lunch', skipped: true }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(app.state().subscriptions[0].skippedMeals.length, 1);

  await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'lunch', skipped: false }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(app.state().subscriptions[0].skippedMeals.length, 0);

  const bad = await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'lunch', status: 'eaten' }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(bad.code, 400);
});

test('the run labels each stop as lunch, dinner or sweets', async () => {
  const data = driverFixture();
  data.users = [
    { ...customer, id: 1, passwordHash: 'x', lat: 12.9744, lng: 77.6743 },
    { ...customer, id: 2, name: 'Sweets Only', phone: '9000000002', passwordHash: 'x', lat: 12.9750, lng: 77.6750 }
  ];
  data.orders = [
    {
      id: 901, orderNumber: '901', userId: 2, status: 'paid', paymentStatus: 'verified',
      createdAt: now, scheduledDate: '2026-10-10', mealService: 'lunch',
      items: [{ id: 1, name: 'Single Meal', price: 129, quantity: 1, customisation: 'Meal A' }],
      customer: { ...customer, lat: 12.9750, lng: 77.6750 }
    },
    {
      id: 902, orderNumber: '902', userId: 2, status: 'paid', paymentStatus: 'verified',
      createdAt: now, scheduledDate: '2026-10-10', mealService: 'dinner',
      items: [{ id: 1, name: 'Single Meal', price: 129, quantity: 1, customisation: 'Meal B' }],
      customer: { ...customer, lat: 12.9751, lng: 77.6751 }
    },
    {
      id: 903, orderNumber: '903', userId: 2, status: 'paid', paymentStatus: 'verified',
      createdAt: now, scheduledDate: '2026-10-10', mealService: null,
      items: [{ id: 6, name: 'Dry Fruits Ladoo', price: 299, quantity: 2, customisation: '200g' }],
      customer: { ...customer, lat: 12.9752, lng: 77.6752 }
    }
  ];
  data.subscriptions = [{
    id: 'sub-1', userId: 1, approved: true, itemName: 'Monthly (Lunch + Dinner)',
    startDate: '2026-10-10', workingDaysRequired: 5, skippedMeals: []
  }];

  const app = application(data);
  const run = await app.request('get', '/api/driver/deliveries', {}, {}, driverAuth);
  const groupOf = (id) => run.body.stops.find((stop) => stop.id === id).group;

  assert.equal(groupOf('901'), 'lunch');
  assert.equal(groupOf('902'), 'dinner');
  assert.equal(groupOf('903'), 'sweets', 'a sweets-only order is not a meal run');

  const subscriptionStops = run.body.stops.filter((stop) => stop.kind === 'subscription');
  assert.equal(subscriptionStops.length, 2);
  assert.equal(subscriptionStops.filter((stop) => stop.group === 'lunch').length, 1);
  assert.equal(subscriptionStops.filter((stop) => stop.group === 'dinner').length, 1);

  // Every stop is labelled, so none can vanish from a grouped list.
  assert.equal(run.body.stops.every((stop) => typeof stop.group === 'string' && stop.group), true);
});

test('an order mixing a meal and sweets rides with its meal slot', async () => {
  const data = driverFixture();
  data.orders = [{
    id: 904, orderNumber: '904', userId: 1, status: 'paid', paymentStatus: 'verified',
    createdAt: now, scheduledDate: '2026-10-10', mealService: 'dinner',
    items: [
      { id: 1, name: 'Single Meal', price: 129, quantity: 1, customisation: 'Meal A' },
      { id: 6, name: 'Dry Fruits Ladoo', price: 299, quantity: 1, customisation: '200g' }
    ],
    customer: { ...customer }
  }];
  const app = application(data);
  const run = await app.request('get', '/api/driver/deliveries', {}, {}, driverAuth);
  assert.equal(run.body.stops.find((stop) => stop.id === '904').group, 'dinner');
});

test('a kitchen failure carries the meal forward and buys back the days to serve it', async () => {
  const app = application(subscriptionFixture());
  const before = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];

  // Today's lunch could not be cooked; dinner went out as normal.
  const result = await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'lunch', status: 'maintenance' }, { id: 'sub-eshwar' }, adminHeaders);
  assert.equal(result.code, 200);

  const after = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  assert.equal(
    after.schedule.find((e) => e.date === '2026-10-10' && e.meal === 'lunch').status,
    'maintenance'
  );
  assert.equal(after.remainingMeals, before.remainingMeals, 'the meal is still owed');
  assert.ok(
    after.carryForwardDeadline > before.carryForwardDeadline,
    'the deadline moves out, unlike a customer skip'
  );
  assert.equal(after.mealsBeyondDeadline, 0, 'so nothing falls off the end');
});

test('a customer skip does not move the deadline', async () => {
  const app = application(subscriptionFixture());
  const before = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];

  await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'lunch', status: 'skipped' }, { id: 'sub-eshwar' }, adminHeaders);

  const after = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];
  assert.equal(after.carryForwardDeadline, before.carryForwardDeadline);
});

test('the deadline grows by delivery days, not calendar days', async () => {
  const app = application(subscriptionFixture());
  const before = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];

  // A whole day lost on a lunch + dinner plan is two meals, so one day back.
  for (const meal of ['lunch', 'dinner']) {
    await app.request('post', '/api/admin/subscriptions/:id/meal',
      { date: '2026-10-10', meal, status: 'maintenance' }, { id: 'sub-eshwar' }, adminHeaders);
  }
  const oneDay = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];

  // Losing only one more meal still needs another whole day to serve it in.
  await app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-12', meal: 'lunch', status: 'maintenance' }, { id: 'sub-eshwar' }, adminHeaders);
  const twoDays = (await app.request('get', '/api/admin/subscriptions', {}, {}, adminHeaders)).body[0];

  assert.ok(oneDay.carryForwardDeadline > before.carryForwardDeadline);
  assert.ok(twoDays.carryForwardDeadline > oneDay.carryForwardDeadline);
  // The extension must land on a delivery day.
  assert.notEqual(new Date(`${twoDays.carryForwardDeadline}T00:00:00Z`).getUTCDay(), 0);
});

test('a meal moves cleanly between maintenance and the other states', async () => {
  const app = application(subscriptionFixture());
  const set = (status) => app.request('post', '/api/admin/subscriptions/:id/meal',
    { date: '2026-10-10', meal: 'lunch', status }, { id: 'sub-eshwar' }, adminHeaders);
  const sub = () => app.state().subscriptions[0];

  await set('maintenance');
  assert.equal(sub().maintenanceMeals.length, 1);
  assert.equal(sub().skippedMeals.length, 0);

  await set('skipped');
  assert.equal(sub().maintenanceMeals.length, 0, 'not recorded as both');
  assert.equal(sub().skippedMeals.length, 1);

  await set('delivered');
  assert.equal(sub().maintenanceMeals.length, 0);
  assert.equal(sub().skippedMeals.length, 0);
  assert.equal(sub().deliveredMeals.length, 1);

  await set('pending');
  assert.equal(sub().maintenanceMeals.length, 0);
  assert.equal(sub().deliveredMeals.length, 0);
});

function kitchenWideFixture() {
  const data = fixture();
  data.users = [
    { ...customer, id: 1, passwordHash: 'x' },
    { ...customer, id: 2, name: 'Second', phone: '9000000002', passwordHash: 'x' },
    { ...customer, id: 3, name: 'Third', phone: '9000000003', passwordHash: 'x' }
  ];
  data.subscriptions = [
    { id: 'sub-a', userId: 1, approved: true, itemName: 'Monthly (Lunch + Dinner)', startDate: '2026-10-10', workingDaysRequired: 26, skippedMeals: [] },
    { id: 'sub-b', userId: 2, approved: true, itemName: 'Monthly (Lunch)', startDate: '2026-10-10', workingDaysRequired: 26, skippedMeals: [] },
    { id: 'sub-c', userId: 3, approved: true, itemName: 'Monthly (Dinner)', startDate: '2026-10-10', workingDaysRequired: 26, skippedMeals: [] }
  ];
  return data;
}

const maintenanceCall = (app, body) =>
  app.request('post', '/api/admin/subscriptions/maintenance', body, {}, adminHeaders);

test('a kitchen-wide failure reaches every subscriber due that meal', async () => {
  const app = application(kitchenWideFixture());
  const result = await maintenanceCall(app, { date: '2026-10-10', meals: ['lunch'] });

  assert.equal(result.code, 200);
  assert.equal(result.body.subscriptions, 2, 'the two lunch plans, not the dinner-only one');

  const byId = new Map(app.state().subscriptions.map((s) => [s.id, s]));
  assert.equal(byId.get('sub-a').maintenanceMeals.length, 1);
  assert.equal(byId.get('sub-b').maintenanceMeals.length, 1);
  assert.equal((byId.get('sub-c').maintenanceMeals || []).length, 0, 'dinner-only plan untouched');
});

test('it leaves alone anyone who had already skipped or been served', async () => {
  const data = kitchenWideFixture();
  data.subscriptions[0].skippedMeals = [{ date: '2026-10-10', meal: 'lunch' }];
  data.subscriptions[1].deliveredMeals = [{ date: '2026-10-10', meal: 'lunch' }];
  const app = application(data);

  const result = await maintenanceCall(app, { date: '2026-10-10', meals: ['lunch'] });
  assert.equal(result.body.subscriptions, 0);

  const byId = new Map(app.state().subscriptions.map((s) => [s.id, s]));
  // A customer who skipped must not be handed a free deadline extension.
  assert.equal((byId.get('sub-a').maintenanceMeals || []).length, 0);
  assert.equal(byId.get('sub-a').skippedMeals.length, 1);
  assert.equal((byId.get('sub-b').maintenanceMeals || []).length, 0);
});

test('running it twice does not double count', async () => {
  const app = application(kitchenWideFixture());
  await maintenanceCall(app, { date: '2026-10-10', meals: ['lunch'] });
  const second = await maintenanceCall(app, { date: '2026-10-10', meals: ['lunch'] });

  assert.equal(second.body.subscriptions, 0);
  assert.equal(app.state().subscriptions[0].maintenanceMeals.length, 1);
});

test('both meals can be reported at once, and customers are told', async () => {
  const app = application(kitchenWideFixture());
  const result = await maintenanceCall(app, { date: '2026-10-10', meals: ['lunch', 'dinner'] });

  assert.equal(result.body.subscriptions, 3, 'every plan lost something');
  assert.equal(app.state().subscriptions[0].maintenanceMeals.length, 2);

  const told = app.notifications.filter((n) => n.data?.type === 'subscription_maintenance');
  assert.equal(told.length, 3);
  assert.match(told[0].body, /added back to your plan/);
});

test('the bulk report is validated and admin-only', async () => {
  const app = application(kitchenWideFixture());
  assert.equal((await app.request('post', '/api/admin/subscriptions/maintenance', { date: '2026-10-10', meals: ['lunch'] }, {}, {})).code, 403);
  assert.equal((await maintenanceCall(app, { date: 'nope', meals: ['lunch'] })).code, 400);
  assert.equal((await maintenanceCall(app, { date: '2026-10-10', meals: [] })).code, 400);
  assert.equal((await maintenanceCall(app, { date: '2026-10-10', meals: ['brunch'] })).code, 400);
  assert.equal((await maintenanceCall(app, { date: '2026-12-25', meals: ['lunch'] })).code, 400, 'not for a future day');
  assert.equal((app.state().subscriptions[0].maintenanceMeals || []).length, 0);
});
