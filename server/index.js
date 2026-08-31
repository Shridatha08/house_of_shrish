import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 4000;

const UPI_ID = 'houseofshrish@ybl';
const MERCHANT_NAME = 'House of Shrish';
// Demo-only shared secret for holiday admin actions; replace with real admin auth in production.
const ADMIN_KEY = process.env.ADMIN_KEY || 'shrish-admin-2026';

// Demo business details for GST invoices. Replace GSTIN with your real registration number.
const BUSINESS = {
  name: 'House of Shrish',
  gstin: '29AAAAA0000A1Z5',
  address: 'Bengaluru, Karnataka, India'
};
// Menu prices are treated as GST-inclusive; 5% GST (2.5% CGST + 2.5% SGST) is typical for
// non-AC restaurants without input tax credit. Adjust if your registration differs.
const GST_RATE = 0.05;

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

// Builds an order number like #31082026-01, using a sequence that resets each day.
function buildOrderNumber(date, dailySequence) {
  const dd = pad(date.getDate());
  const mm = pad(date.getMonth() + 1);
  const yyyy = date.getFullYear();
  return `${dd}${mm}${yyyy}-${pad(dailySequence)}`;
}

app.use(cors());
app.use(express.json());

async function getUserFromToken(db, req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const session = db.data.sessions.find((s) => s.token === token);
  if (!session) return null;
  return db.data.users.find((u) => u.id === session.userId) || null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, phone: user.phone, address: user.address || '' };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Counts a date as a working day when it isn't a Sunday and isn't an admin-added holiday.
function isWorkingDay(dateStr, holidays) {
  const dow = new Date(`${dateStr}T00:00:00`).getDay();
  if (dow === 0) return false;
  return !holidays.some((h) => h.date === dateStr);
}

// Finds the date on which the Nth working day (inclusive of the start date) falls.
function computeSubscriptionEndDate(startDate, requiredWorkingDays, holidays) {
  let count = 0;
  const cursor = new Date(`${startDate}T00:00:00`);
  for (let i = 0; i < requiredWorkingDays * 3; i++) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (isWorkingDay(dateStr, holidays)) {
      count++;
      if (count === requiredWorkingDays) return dateStr;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

// POST /api/auth/register - create a new account
app.post('/api/auth/register', async (req, res) => {
  const { name, phone, password, address } = req.body || {};

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (typeof phone !== 'string' || !/^\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ error: 'A valid 10-digit phone number is required.' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (typeof address !== 'string' || !address.trim()) {
    return res.status(400).json({ error: 'Address is required.' });
  }

  const db = await getDb();
  if (db.data.users.some((u) => u.phone === phone.trim())) {
    return res.status(409).json({ error: 'An account with this phone number already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now(),
    name: name.trim(),
    phone: phone.trim(),
    address: address.trim(),
    passwordHash,
    createdAt: new Date().toISOString()
  };
  db.data.users.push(user);

  const token = crypto.randomBytes(24).toString('hex');
  db.data.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  await db.write();

  res.status(201).json({ user: publicUser(user), token });
});

// POST /api/auth/login - authenticate an existing account
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body || {};

  if (typeof phone !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Phone number and password are required.' });
  }

  const db = await getDb();
  const user = db.data.users.find((u) => u.phone === phone.trim());
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid phone number or password.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  db.data.sessions.push({ token, userId: user.id, createdAt: new Date().toISOString() });
  await db.write();

  res.json({ user: publicUser(user), token });
});

// GET /api/auth/me - fetch the account for the current session token
app.get('/api/auth/me', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: publicUser(user) });
});

// PATCH /api/auth/profile - update the current user's personal details
app.patch('/api/auth/profile', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const { name, phone, address } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (typeof phone !== 'string' || !/^\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ error: 'A valid 10-digit phone number is required.' });
  }
  if (typeof address !== 'string' || !address.trim()) {
    return res.status(400).json({ error: 'Address is required.' });
  }
  if (db.data.users.some((u) => u.id !== user.id && u.phone === phone.trim())) {
    return res.status(409).json({ error: 'Another account already uses this phone number.' });
  }

  user.name = name.trim();
  user.phone = phone.trim();
  user.address = address.trim();
  await db.write();

  res.json({ user: publicUser(user) });
});

// GET /api/menu - list all menu items
app.get('/api/menu', async (req, res) => {
  const db = await getDb();
  res.json(db.data.menu);
});

// GET /api/holidays - list admin-added holidays
app.get('/api/holidays', async (req, res) => {
  const db = await getDb();
  res.json(db.data.holidays);
});

// GET /api/admin/verify - check whether the supplied admin key is valid, without mutating anything
app.get('/api/admin/verify', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  res.json({ ok: true });
});

// POST /api/holidays - add a holiday (requires admin key)
app.post('/api/holidays', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const { date, name } = req.body || {};
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });
  }
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Holiday name is required.' });
  }

  const db = await getDb();
  if (db.data.holidays.some((h) => h.date === date)) {
    return res.status(409).json({ error: 'A holiday is already set for this date.' });
  }
  const holiday = { id: Date.now(), date, name: name.trim() };
  db.data.holidays.push(holiday);
  await db.write();
  res.status(201).json(holiday);
});

// DELETE /api/holidays/:id - remove a holiday (requires admin key)
app.delete('/api/holidays/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  const before = db.data.holidays.length;
  db.data.holidays = db.data.holidays.filter((h) => h.id !== Number(req.params.id));
  if (db.data.holidays.length === before) {
    return res.status(404).json({ error: 'Holiday not found.' });
  }
  await db.write();
  res.status(204).end();
});

// GET /api/admin/settings - fetch subscription settings (requires admin key)
app.get('/api/admin/settings', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  res.json(db.data.settings);
});

// PATCH /api/admin/settings - update subscription settings (requires admin key)
app.patch('/api/admin/settings', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const { subscriptionWorkingDays } = req.body || {};
  const days = Number(subscriptionWorkingDays);
  if (!Number.isInteger(days) || days <= 0 || days > 365) {
    return res.status(400).json({ error: 'Subscription working days must be a positive number.' });
  }
  const db = await getDb();
  db.data.settings.subscriptionWorkingDays = days;
  await db.write();
  res.json(db.data.settings);
});

// GET /api/subscriptions/me - list the current user's Monthly subscriptions with computed end dates
app.get('/api/subscriptions/me', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const today = todayStr();
  const result = db.data.subscriptions
    .filter((s) => s.userId === user.id)
    .map((s) => {
      const endDate = computeSubscriptionEndDate(s.startDate, s.workingDaysRequired, db.data.holidays);
      return {
        ...s,
        endDate,
        expiresToday: endDate === today,
        expired: Boolean(endDate) && endDate < today
      };
    });

  res.json(result);
});

// GET /api/admin/subscriptions - list every user's Monthly subscriptions (requires admin key)
app.get('/api/admin/subscriptions', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  const usersById = new Map(db.data.users.map((u) => [u.id, u]));
  const today = todayStr();

  const result = db.data.subscriptions.map((s) => {
    const endDate = computeSubscriptionEndDate(s.startDate, s.workingDaysRequired, db.data.holidays);
    const user = usersById.get(s.userId);
    return {
      ...s,
      endDate,
      expiresToday: endDate === today,
      expired: Boolean(endDate) && endDate < today,
      customerName: user?.name || 'Unknown',
      customerPhone: user?.phone || ''
    };
  });

  res.json(result);
});

// PATCH /api/admin/subscriptions/:id - adjust a subscription's start date or duration (requires admin key)
app.patch('/api/admin/subscriptions/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  const subscription = db.data.subscriptions.find((s) => s.id === req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Subscription not found.' });

  const { startDate, workingDaysRequired } = req.body || {};
  if (startDate !== undefined) {
    if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return res.status(400).json({ error: 'Start date must be in YYYY-MM-DD format.' });
    }
    subscription.startDate = startDate;
  }
  if (workingDaysRequired !== undefined) {
    const days = Number(workingDaysRequired);
    if (!Number.isInteger(days) || days <= 0 || days > 365) {
      return res.status(400).json({ error: 'Working days must be a positive number.' });
    }
    subscription.workingDaysRequired = days;
  }
  await db.write();

  const endDate = computeSubscriptionEndDate(subscription.startDate, subscription.workingDaysRequired, db.data.holidays);
  res.json({ ...subscription, endDate });
});

// POST /api/orders - place a new order
app.post('/api/orders', async (req, res) => {
  const { items, customer } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Order must include at least one item.' });
  }
  if (!customer || typeof customer.name !== 'string' || !customer.name.trim()) {
    return res.status(400).json({ error: 'Customer name is required.' });
  }
  if (typeof customer.phone !== 'string' || !/^\d{10}$/.test(customer.phone.trim())) {
    return res.status(400).json({ error: 'A valid 10-digit phone number is required.' });
  }
  if (typeof customer.address !== 'string' || !customer.address.trim()) {
    return res.status(400).json({ error: 'Delivery address is required.' });
  }

  const db = await getDb();
  const menuById = new Map(db.data.menu.map((item) => [item.id, item]));

  const user = await getUserFromToken(db, req);
  const requiresAccount = items.some((line) => {
    const menuItem = menuById.get(Number(line.id));
    return menuItem && menuItem.name.toLowerCase().startsWith('monthly');
  });
  if (requiresAccount && !user) {
    return res.status(401).json({ error: 'Please sign up or log in to order Monthly packages.' });
  }

  let total = 0;
  const orderItems = [];
  for (const line of items) {
    const menuItem = menuById.get(Number(line.id));
    const quantity = Number(line.quantity);
    if (!menuItem || !Number.isInteger(quantity) || quantity <= 0 || quantity > 50) {
      return res.status(400).json({ error: 'Invalid item in cart.' });
    }
    let customisation = '';
    if (Array.isArray(menuItem.customisations) && menuItem.customisations.length > 0) {
      if (!menuItem.customisations.includes(line.customisation)) {
        return res.status(400).json({ error: `Invalid customisation for ${menuItem.name}.` });
      }
      customisation = line.customisation;
    }
    total += menuItem.price * quantity;
    orderItems.push({ id: menuItem.id, name: menuItem.name, price: menuItem.price, quantity, customisation });
  }

  const orderId = Date.now();
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const ordersToday = db.data.orders.filter((o) => o.createdAt.slice(0, 10) === todayKey).length;
  const order = {
    id: orderId,
    orderNumber: buildOrderNumber(now, ordersToday + 1),
    items: orderItems,
    total,
    customer: {
      name: customer.name.trim(),
      phone: customer.phone.trim(),
      address: customer.address.trim(),
      lat: Number.isFinite(customer.lat) ? customer.lat : null,
      lng: Number.isFinite(customer.lng) ? customer.lng : null
    },
    status: 'pending_payment',
    createdAt: new Date().toISOString()
  };

  db.data.orders.push(order);

  if (user) {
    const startDate = order.createdAt.slice(0, 10);
    for (const item of orderItems) {
      if (item.name.toLowerCase().startsWith('monthly')) {
        db.data.subscriptions.push({
          id: `${order.id}-${item.id}`,
          userId: user.id,
          orderId: order.id,
          itemName: item.name,
          startDate,
          workingDaysRequired: db.data.settings.subscriptionWorkingDays,
          createdAt: new Date().toISOString()
        });
      }
    }
  }

  await db.write();

  const upiUri = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${total}&cu=INR&tn=${encodeURIComponent('Order ' + order.id)}`;

  res.status(201).json({ order, upiUri });
});

// GET /api/orders/:id - fetch a single order's status
app.get('/api/orders/:id', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json(order);
});

// PATCH /api/orders/:id/mark-paid - mark an order as paid (called once user confirms payment)
app.patch('/api/orders/:id/mark-paid', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  order.status = 'paid';
  await db.write();
  res.json(order);
});

// GET /api/orders/:id/invoice - GST invoice breakdown for a paid order
app.get('/api/orders/:id/invoice', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });

  const taxableValue = Math.round((order.total / (1 + GST_RATE)) * 100) / 100;
  const totalTax = Math.round((order.total - taxableValue) * 100) / 100;
  const cgst = Math.round((totalTax / 2) * 100) / 100;
  const sgst = totalTax - cgst;

  const items = order.items.map((item) => {
    const lineTotal = item.price * item.quantity;
    const lineTaxable = Math.round((lineTotal / (1 + GST_RATE)) * 100) / 100;
    return { ...item, lineTotal, lineTaxable, lineTax: Math.round((lineTotal - lineTaxable) * 100) / 100 };
  });

  res.json({
    invoiceNumber: `INV-${order.orderNumber || order.id}`,
    orderNumber: order.orderNumber || String(order.id),
    date: order.createdAt,
    business: BUSINESS,
    gstRate: GST_RATE,
    customer: order.customer,
    items,
    taxableValue,
    cgst,
    sgst,
    total: order.total
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
