const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const dbSource = fs.readFileSync(path.join(__dirname, '../db.js'), 'utf8');
const customer = { name: 'Test Customer', phone: '9000000000', address: 'Test Street', flatNumber: 'A-12', pincode: '560075' };
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

function application(data = fixture()) {
  let state = structuredClone(data);
  let clock = new Date(now).getTime();
  const routes = new Map();
  const notifications = [];
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
    removeDeviceToken: (data, token) => {
      data.deviceTokens = (data.deviceTokens || []).filter((entry) => entry.token !== token);
    },
    bcrypt: { hash: async (password) => `hashed:${password}`, compare: async (password, hash) => hash === `hashed:${password}` },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    getDb: async () => {
      const snapshot = structuredClone(state);
      return { data: snapshot, write: async () => {
        if (snapshot.revision !== state.revision) throw Object.assign(new Error('Stale write'), { status: 409 });
        snapshot.revision++;
        state = structuredClone(snapshot);
      } };
    }
  };
  vm.createContext(context);
  vm.runInContext(source.replace(/^import .*;\r?$/gm, ''), context);
  return {
    context,
    state: () => state,
    notifications,
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

test('actual persistence adapter rejects competing snapshots instead of losing data', async () => {
  let state;
  const collection = {
    async findOne() { return structuredClone(state); },
    async updateOne(filter, update) {
      if (update.$setOnInsert) { state ||= { _id: 'main', ...structuredClone(update.$setOnInsert) }; return { matchedCount: 1 }; }
      const matches = typeof filter.revision === 'object' ? state.revision === undefined : state.revision === filter.revision;
      if (!matches) return { matchedCount: 0 };
      Object.assign(state, structuredClone(update.$set));
      return { matchedCount: 1 };
    }
  };
  const context = { structuredClone, process: { env: { MONGODB_URI: 'mock' } }, MongoClient: class { connect() { return Promise.resolve({ db: () => ({ collection: () => collection }) }); } } };
  vm.createContext(context);
  vm.runInContext(dbSource.replace(/^import .*;\r?$/gm, '').replace('export async function', 'async function'), context);
  const first = await context.getDb();
  const second = await context.getDb();
  first.data.orders.push({ id: 1 });
  await first.write();
  second.data.orders.push({ id: 2 });
  await assert.rejects(second.write(), (error) => error.status === 409);
  assert.equal(state.orders.length, 1);
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
  assert.ok(orders.notifications.slice(1).every((entry) => entry.audience === 'order'));
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
