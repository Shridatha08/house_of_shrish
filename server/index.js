import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 4000;

const UPI_ID = 'houseofshrish@ybl';
const MERCHANT_NAME = 'House of Shrish';
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) throw new Error('ADMIN_KEY environment variable is required.');

// Demo business details shown on invoices.
const BUSINESS = {
  name: 'House of Shrish',
  address: 'Bengaluru, Karnataka, India'
};

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

// Builds an order number like #31082026-01, using a sequence that resets each day.
function buildOrderNumber(date, dailySequence) {
  const dd = pad(date.getUTCDate());
  const mm = pad(date.getUTCMonth() + 1);
  const yyyy = date.getUTCFullYear();
  return `${dd}${mm}${yyyy}-${pad(dailySequence)}`;
}

app.use(cors());
app.use(express.json());

const rateLimitBuckets = new Map();
function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  return (req, res, next) => {
    const bucketKey = `${key(req)}:${req.path}`;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    next();
  };
}

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self' https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; connect-src 'self' https:; frame-ancestors 'none'"
  });
  next();
});

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const adminRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, key: (req) => req.ip });
app.use('/api/admin', adminRateLimit);

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

function getOrderToken(req) {
  return req.headers['x-order-token'] || null;
}

function canAccessOrder(order, user, req) {
  return (user && order.userId === user.id) || order.accessToken === getOrderToken(req);
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value;
}

function isValidTimeSlot(value) {
  return value === '11:00-13:00' || value === '18:00-20:00';
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Counts a date as a working day when it isn't a Sunday and isn't an admin-added holiday.
// Uses UTC throughout so results don't shift depending on the server's local timezone.
function isWorkingDay(dateStr, holidays) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  if (dow === 0) return false;
  return !holidays.some((h) => h.date === dateStr);
}

// Finds the date on which the Nth working day (inclusive of the start date) falls.
function computeSubscriptionEndDate(startDate, requiredWorkingDays, holidays) {
  let count = 0;
  const cursor = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < requiredWorkingDays * 3; i++) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (isWorkingDay(dateStr, holidays)) {
      count++;
      if (count === requiredWorkingDays) return dateStr;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

// Counts remaining working days (meal-delivery days) from `today` through `endDate`, inclusive.
function countWorkingDaysRemaining(today, endDate, holidays) {
  if (!endDate || endDate < today) return 0;
  let count = 0;
  const cursor = new Date(`${today}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    const dateStr = cursor.toISOString().slice(0, 10);
    if (isWorkingDay(dateStr, holidays)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

// POST /api/auth/register - create a new account
app.post('/api/auth/register', authRateLimit, async (req, res) => {
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
app.post('/api/auth/login', authRateLimit, async (req, res) => {
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

// POST /api/auth/password-reset/verify-phone - exchange a Phone.Email verification URL for a reset token
app.post('/api/auth/password-reset/verify-phone', authRateLimit, async (req, res) => {
  const { userJsonUrl } = req.body || {};
  let verificationUrl;
  try {
    verificationUrl = new URL(userJsonUrl);
  } catch {
    return res.status(400).json({ error: 'A valid Phone.Email verification is required.' });
  }
  if (verificationUrl.protocol !== 'https:' || verificationUrl.hostname !== 'user.phone.email') {
    return res.status(400).json({ error: 'Invalid Phone.Email verification URL.' });
  }

  let verifiedUser;
  try {
    const verificationResponse = await fetch(verificationUrl, { signal: AbortSignal.timeout(10_000) });
    if (!verificationResponse.ok) throw new Error('Phone.Email verification failed.');
    verifiedUser = await verificationResponse.json();
  } catch {
    return res.status(400).json({ error: 'Phone verification could not be confirmed. Please try again.' });
  }

  const countryCode = String(verifiedUser.user_country_code || '').replace(/\D/g, '');
  const phoneNumber = String(verifiedUser.user_phone_number || '').replace(/\D/g, '');
  const phone = countryCode === '91' && phoneNumber.length === 10 ? phoneNumber : '';
  if (!phone) {
    return res.status(400).json({ error: 'Please verify the 10-digit mobile number registered with this account.' });
  }

  const db = await getDb();
  const user = db.data.users.find((candidate) => candidate.phone === phone);
  if (!user) {
    return res.status(404).json({ error: 'No account is registered with this phone number.' });
  }

  const now = Date.now();
  db.data.passwordResetTokens = (db.data.passwordResetTokens || []).filter((entry) => entry.expiresAt > now);
  const resetToken = crypto.randomBytes(32).toString('hex');
  db.data.passwordResetTokens.push({ token: resetToken, userId: user.id, expiresAt: now + 10 * 60 * 1000 });
  await db.write();
  res.json({ resetToken });
});

// POST /api/auth/password-reset - set a new password after Phone.Email verification
app.post('/api/auth/password-reset', authRateLimit, async (req, res) => {
  const { resetToken, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const db = await getDb();
  const now = Date.now();
  db.data.passwordResetTokens = (db.data.passwordResetTokens || []).filter((entry) => entry.expiresAt > now);
  const resetEntry = db.data.passwordResetTokens.find((entry) => entry.token === resetToken);
  if (!resetEntry) return res.status(400).json({ error: 'This reset link has expired. Verify your phone number again.' });

  const user = db.data.users.find((candidate) => candidate.id === resetEntry.userId);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  user.passwordHash = await bcrypt.hash(password, 10);
  db.data.passwordResetTokens = db.data.passwordResetTokens.filter((entry) => entry.token !== resetToken);
  db.data.sessions = db.data.sessions.filter((session) => session.userId !== user.id);
  await db.write();
  res.status(204).end();
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

// GET /api/subscriptions/me - list the current user's admin-approved Monthly subscriptions
app.get('/api/subscriptions/me', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const today = todayStr();
  const result = db.data.subscriptions
    .filter((s) => s.userId === user.id && s.approved)
    .map((s) => {
      const endDate = computeSubscriptionEndDate(s.startDate, s.workingDaysRequired, db.data.holidays);
      const daysRemaining = countWorkingDaysRemaining(today, endDate, db.data.holidays);
      return {
        ...s,
        endDate,
        daysRemaining,
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

// PATCH /api/admin/subscriptions/:id/approve - make a pending subscription visible to the user (requires admin key)
app.patch('/api/admin/subscriptions/:id/approve', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  const subscription = db.data.subscriptions.find((s) => s.id === req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Subscription not found.' });
  subscription.approved = true;
  await db.write();

  const endDate = computeSubscriptionEndDate(subscription.startDate, subscription.workingDaysRequired, db.data.holidays);
  res.json({ ...subscription, endDate });
});

// GET /api/admin/users - list all registered users (requires admin key)
app.get('/api/admin/users', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  res.json(db.data.users.map((u) => ({ id: u.id, name: u.name, phone: u.phone, address: u.address || '', createdAt: u.createdAt })));
});

// DELETE /api/admin/users/:id - remove a registered user and their sessions/subscriptions (requires admin key)
app.delete('/api/admin/users/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  const userId = Number(req.params.id);
  const before = db.data.users.length;
  db.data.users = db.data.users.filter((u) => u.id !== userId);
  if (db.data.users.length === before) {
    return res.status(404).json({ error: 'User not found.' });
  }
  db.data.sessions = db.data.sessions.filter((s) => s.userId !== userId);
  db.data.subscriptions = db.data.subscriptions.filter((s) => s.userId !== userId);
  await db.write();
  res.status(204).end();
});

// GET /api/admin/orders - operational order queue
app.get('/api/admin/orders', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const db = await getDb();
  res.json(db.data.orders
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ accessToken, ...order }) => order));
});

// PATCH /api/admin/orders/:id/status - update fulfillment or refund status
app.patch('/api/admin/orders/:id/status', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const allowedStatuses = ['paid', 'preparing', 'out_for_delivery', 'delivered', 'cancelled', 'refund_requested', 'refunded'];
  const { status } = req.body || {};
  if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Invalid order status.' });
  const db = await getDb();
  const order = db.data.orders.find((candidate) => candidate.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  order.status = status;
  order.statusUpdatedAt = new Date().toISOString();
  if (status === 'refunded') order.refundedAt = order.statusUpdatedAt;
  await db.write();
  const { accessToken, ...safeOrder } = order;
  res.json(safeOrder);
});

// POST /api/orders - place a new order
app.post('/api/orders', async (req, res) => {
  const { items, customer, scheduledDate, timeSlot } = req.body || {};

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
  if (!isValidDateString(scheduledDate) || scheduledDate < todayStr()) {
    return res.status(400).json({ error: 'Choose a valid delivery date from today onward.' });
  }
  if (!isValidTimeSlot(timeSlot)) {
    return res.status(400).json({ error: 'Choose a valid delivery time slot.' });
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
  const accessToken = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const todayKey = now.toISOString().slice(0, 10);
  const ordersToday = db.data.orders.filter((o) => o.createdAt.slice(0, 10) === todayKey).length;
  const order = {
    id: orderId,
    orderNumber: buildOrderNumber(now, ordersToday + 1),
    items: orderItems,
    total,
    userId: user?.id || null,
    accessToken,
    scheduledDate,
    timeSlot,
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
          approved: false,
          createdAt: new Date().toISOString()
        });
      }
    }
  }

  await db.write();

  const upiUri = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${total}&cu=INR&tn=${encodeURIComponent('Order ' + order.id)}`;

  res.status(201).json({ order: { ...order, accessToken: undefined }, upiUri, accessToken });
});

// GET /api/orders/:id - fetch a single order's status
app.get('/api/orders/:id', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const user = await getUserFromToken(db, req);
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot access this order.' });
  const { accessToken, ...safeOrder } = order;
  res.json(safeOrder);
});

// PATCH /api/orders/:id/mark-paid - mark an order as paid (called once user confirms payment)
app.patch('/api/orders/:id/mark-paid', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const user = await getUserFromToken(db, req);
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot update this order.' });
  if (order.status !== 'pending_payment') return res.status(409).json({ error: 'This order is no longer awaiting payment.' });
  order.status = 'paid';
  order.paymentSubmittedAt = new Date().toISOString();
  await db.write();
  const { accessToken, ...safeOrder } = order;
  res.json(safeOrder);
});

// GET /api/orders/me - authenticated customer's order history
app.get('/api/orders/me', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  res.json(db.data.orders.filter((order) => order.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(({ accessToken, ...order }) => order));
});

// PATCH /api/orders/:id/cancel - customer cancellation before fulfillment
app.patch('/api/orders/:id/cancel', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  const user = await getUserFromToken(db, req);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot update this order.' });
  if (!['pending_payment', 'paid'].includes(order.status)) return res.status(409).json({ error: 'This order can no longer be cancelled.' });
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  await db.write();
  const { accessToken, ...safeOrder } = order;
  res.json(safeOrder);
});

// POST /api/orders/:id/refund-request - request a refund for an eligible paid order
app.post('/api/orders/:id/refund-request', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  const user = await getUserFromToken(db, req);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot update this order.' });
  if (!['paid', 'cancelled'].includes(order.status)) return res.status(409).json({ error: 'This order is not eligible for a refund request.' });
  order.status = 'refund_requested';
  order.refundRequestedAt = new Date().toISOString();
  await db.write();
  const { accessToken, ...safeOrder } = order;
  res.json(safeOrder);
});

// GET /api/orders/:id/invoice - invoice breakdown for an authorized paid order
app.get('/api/orders/:id/invoice', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const user = await getUserFromToken(db, req);
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot access this invoice.' });
  if (order.status === 'pending_payment') return res.status(409).json({ error: 'Invoice is available after payment confirmation.' });

  const items = order.items.map((item) => ({ ...item, lineTotal: item.price * item.quantity }));

  res.json({
    invoiceNumber: `INV-${order.orderNumber || order.id}`,
    orderNumber: order.orderNumber || String(order.id),
    date: order.createdAt,
    business: BUSINESS,
    customer: order.customer,
    items,
    total: order.total
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
