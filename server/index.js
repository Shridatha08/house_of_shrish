import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb } from './db.js';

const app = express();
const PORT = process.env.PORT || 4000;
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

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
    const bucketKey = `${key(req)}:${req.baseUrl || req.path}`;
    const now = Date.now();
    if (rateLimitBuckets.size > 1000) {
      for (const [storedKey, value] of rateLimitBuckets) if (value.resetAt <= now) rateLimitBuckets.delete(storedKey);
    }
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
  if (!session.createdAt || Date.now() - new Date(session.createdAt).getTime() >= 30 * 24 * 60 * 60 * 1000) return null;
  return db.data.users.find((u) => u.id === session.userId) || null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, phone: user.phone, address: user.address || '', flatNumber: user.flatNumber || '', pincode: user.pincode || '' };
}

function validDeliveryDetails(details) {
  return typeof details.flatNumber === 'string' && details.flatNumber.trim().length > 0 && details.flatNumber.length <= 100 &&
    typeof details.pincode === 'string' && /^[1-9]\d{5}$/.test(details.pincode.trim());
}

function businessDate(iso) {
  return new Date(new Date(iso).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function reservesStock(order) {
  if (['cancelled', 'refund_requested', 'refunded'].includes(order.status)) return false;
  return order.status !== 'pending_payment' || Date.now() - new Date(order.createdAt).getTime() < 30 * 60 * 1000;
}

function subscriptionInService(subscription, data) {
  if (!subscription.approved || subscription.deactivated) return false;
  if (!subscription.orderId) return true;
  const order = data.orders.find((entry) => entry.id === subscription.orderId);
  return Boolean(order && paymentStatus(order) === 'verified' && !['cancelled', 'refund_requested', 'refunded'].includes(order.status));
}

function stockUsed(data, date, itemId) {
  return data.orders.filter((order) => reservesStock(order) && businessDate(order.createdAt) === date)
    .reduce((total, order) => total + order.items.filter((item) => item.id === itemId).reduce((quantity, item) => quantity + item.quantity, 0), 0);
}

function kitchenMealCount(data, date) {
  const menuById = new Map(data.menu.map((item) => [item.id, item]));
  const purchases = data.orders.filter((order) => reservesStock(order) && (order.scheduledDate || businessDate(order.createdAt)) === date)
    .reduce((total, order) => total + order.items.filter((item) => menuById.get(item.id)?.category === 'Pure Veg Meals' && !item.name.toLowerCase().startsWith('monthly'))
      .reduce((quantity, item) => quantity + item.quantity, 0), 0);
  const subscriptions = data.subscriptions.filter((subscription) => subscriptionInService(subscription, data))
    .reduce((total, subscription) => total + buildSubscriptionSchedule(subscription, subscriptionHolidays(data)).schedule
      .filter((entry) => entry.date === date && entry.status !== 'skipped').length, 0);
  return purchases + subscriptions;
}

function getOrderToken(req) {
  return req.headers['x-order-token'] || null;
}

function canAccessOrder(order, user, req) {
  return Boolean((user && order.userId === user.id) || (order.accessToken && order.accessToken === getOrderToken(req)));
}

function paymentStatus(order) {
  return order.paymentStatus || (['paid', 'preparing', 'out_for_delivery', 'delivered', 'refunded'].includes(order.status) ? 'verified' : 'unpaid');
}

function deactivateSubscriptions(data, order) {
  for (const subscription of data.subscriptions.filter((entry) => entry.orderId === order.id)) {
    subscription.approved = false;
    subscription.deactivated = true;
  }
}

function subscriptionHolidays(data) {
  return [...data.holidays, ...getSettings(data).kitchenClosedDates.map((date) => ({ date }))];
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidTimeSlot(value) {
  return ['11:00-13:00', '18:00-20:00'].includes(value);
}

function getSettings(data) {
  return {
    subscriptionWorkingDays: 26,
    announcement: '',
    orderingPaused: false,
    kitchenClosedDates: [],
    dailyOrderCapacity: 50,
    lunchCutoffTime: '11:00',
    dinnerCutoffTime: '18:30',
    deliveryTimeSlots: ['11:00-13:00', '18:00-20:00'],
    ...(data.settings || {})
  };
}

function isBeforeCutoff(cutoff, now = new Date()) {
  const [hours, minutes] = cutoff.split(':').map(Number);
  const currentTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now);
  const currentHours = Number(currentTime.find((part) => part.type === 'hour').value);
  const currentMinutes = Number(currentTime.find((part) => part.type === 'minute').value);
  return currentHours * 60 + currentMinutes < hours * 60 + minutes;
}

function getOrderMealService(settings, now = new Date()) {
  if (isBeforeCutoff(settings.lunchCutoffTime, now)) return 'lunch';
  if (isBeforeCutoff(settings.dinnerCutoffTime, now)) return 'dinner';
  return null;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function todayISTStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const part = (type) => parts.find((value) => value.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function getSubscriptionMealSlots(itemName) {
  const name = String(itemName || '').toLowerCase();
  if (name.includes('lunch + dinner') || name.includes('lunch and dinner') || name.includes('both')) return ['lunch', 'dinner'];
  if (name.includes('dinner')) return ['dinner'];
  return ['lunch'];
}

function canCancelSubscriptionMeal(date, meal) {
  const today = todayISTStr();
  if (date > today) return true;
  if (date < today) return false;
  const cutoffHour = meal === 'lunch' ? 11 : 18;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === 'hour').value);
  const minute = Number(parts.find((part) => part.type === 'minute').value);
  return hour * 60 + minute < cutoffHour * 60;
}

function buildSubscriptionSchedule(subscription, holidays) {
  const today = todayISTStr();
  const requiredDays = Number(subscription.workingDaysRequired);
  const mealSlots = Array.isArray(subscription.mealSlots) && subscription.mealSlots.length
    ? ['lunch', 'dinner'].filter((meal) => subscription.mealSlots.includes(meal))
    : getSubscriptionMealSlots(subscription.itemName);
  if (subscription.deactivated || !isValidDateString(subscription.startDate) || !Number.isInteger(requiredDays) || requiredDays < 1) {
    return { mealSlots, schedule: [], endDate: null, daysRemaining: 0, remainingMeals: 0, expiresToday: false, expired: true };
  }

  const skipped = new Set((subscription.skippedMeals || []).map((entry) => `${entry.date}:${entry.meal}`));
  const requiredMeals = requiredDays * mealSlots.length;
  let deliveredMeals = 0;
  const schedule = [];
  const cursor = new Date(`${subscription.startDate}T00:00:00Z`);
  let endDate = null;
  const maxDays = Math.min(10000, Math.max(730, (requiredDays + skipped.size + 10) * 3));

  for (let offset = 0; offset < maxDays; offset++) {
    const date = cursor.toISOString().slice(0, 10);
    if (isWorkingDay(date, holidays)) {
      for (const meal of mealSlots) {
        if (deliveredMeals >= requiredMeals) break;
        const isSkipped = skipped.has(`${date}:${meal}`);
        if (isSkipped) {
          schedule.push({ date, meal, status: 'skipped', canCancel: false });
          continue;
        }
        const status = date < today ? 'elapsed' : 'upcoming';
        schedule.push({ date, meal, status, canCancel: status === 'upcoming' && canCancelSubscriptionMeal(date, meal) });
        deliveredMeals++;
        endDate = date;
      }
      if (deliveredMeals >= requiredMeals) break;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const upcomingEntries = schedule.filter((entry) => entry.status === 'upcoming');
  const daysRemaining = new Set(upcomingEntries.map((entry) => entry.date)).size;
  const remainingMeals = upcomingEntries.length;
  return {
    mealSlots,
    schedule,
    endDate,
    daysRemaining,
    remainingMeals,
    expiresToday: endDate === today,
    expired: Boolean(endDate) && endDate < today
  };
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
  const { name, phone, password, address, flatNumber, pincode } = req.body || {};

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

  if (!validDeliveryDetails({ flatNumber, pincode })) return res.status(400).json({ error: 'Enter a flat/door number and valid 6-digit pincode.' });
  const db = await getDb();
  if (db.data.users.some((u) => u.phone === phone.trim())) {
    return res.status(409).json({ error: 'An account with this phone number already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomBytes(6).readUIntBE(0, 6),
    name: name.trim(),
    phone: phone.trim(),
    address: address.trim(),
    flatNumber: flatNumber.trim(),
    pincode: pincode.trim(),
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

// POST /api/auth/password-reset/request - queue an admin-approved reset request
app.post('/api/auth/password-reset/request', authRateLimit, async (req, res) => {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });

  const db = await getDb();
  const user = db.data.users.find((candidate) => candidate.phone === phone);
  if (user) {
    db.data.passwordResetRequests ||= [];
    const now = Date.now();
    const activeRequest = db.data.passwordResetRequests.find((entry) =>
      entry.userId === user.id && (entry.status === 'pending' || (entry.status === 'key_issued' && entry.expiresAt > now))
    );
    if (!activeRequest) {
      db.data.passwordResetRequests.push({
        id: crypto.randomBytes(12).toString('hex'),
        userId: user.id,
        phone: user.phone,
        status: 'pending',
        requestedAt: new Date(now).toISOString()
      });
      await db.write();
    }
  }

  res.status(202).json({ message: 'If an account exists for that number, a reset request has been sent to the admin.' });
});

// POST /api/auth/password-reset/complete - consume a one-time key issued by an admin
app.post('/api/auth/password-reset/complete', authRateLimit, async (req, res) => {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
  const resetKey = typeof req.body?.resetKey === 'string' ? req.body.resetKey.trim().toUpperCase() : '';
  const { password } = req.body || {};
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit phone number.' });
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const db = await getDb();
  db.data.passwordResetRequests ||= [];
  const user = db.data.users.find((candidate) => candidate.phone === phone);
  const now = Date.now();
  const resetRequest = user && db.data.passwordResetRequests
    .filter((entry) => entry.userId === user.id && entry.status === 'key_issued' && entry.expiresAt > now)
    .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))[0];
  const suppliedHash = crypto.createHash('sha256').update(resetKey).digest();
  const storedHash = resetRequest?.keyHash ? Buffer.from(resetRequest.keyHash, 'hex') : Buffer.alloc(0);
  const keyMatches = storedHash.length === suppliedHash.length && crypto.timingSafeEqual(storedHash, suppliedHash);
  if (!user || !resetRequest || !keyMatches) {
    return res.status(400).json({ error: 'Invalid or expired reset key.' });
  }

  user.passwordHash = await bcrypt.hash(password, 10);
  if (resetRequest.expiresAt <= Date.now()) return res.status(400).json({ error: 'This reset key has expired.' });
  for (const entry of db.data.passwordResetRequests) {
    if (entry.userId === user.id && entry.status !== 'completed') {
      entry.status = 'completed';
      entry.keyHash = null;
      entry.completedAt = new Date(now).toISOString();
    }
  }
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

app.post('/api/auth/logout', async (req, res) => {
  const db = await getDb();
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  db.data.sessions = db.data.sessions.filter((session) => session.token !== token);
  await db.write();
  res.status(204).end();
});

// PATCH /api/auth/profile - update the current user's personal details
app.patch('/api/auth/profile', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const { name, phone, address, flatNumber, pincode } = req.body || {};
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
  if (!validDeliveryDetails({ flatNumber, pincode })) return res.status(400).json({ error: 'Enter a flat/door number and valid 6-digit pincode.' });

  user.name = name.trim();
  user.phone = phone.trim();
  user.address = address.trim();
  user.flatNumber = flatNumber.trim();
  user.pincode = pincode.trim();
  await db.write();

  res.json({ user: publicUser(user) });
});

// GET /api/menu - list all menu items
app.get('/api/menu', async (req, res) => {
  const db = await getDb();
  const settings = getSettings(db.data);
  const today = todayISTStr();
  res.json(db.data.menu.map((item) => {
    const remainingStock = Number.isInteger(item.dailyStock) ? Math.max(0, item.dailyStock - stockUsed(db.data, today, item.id)) : null;
    return { ...item, available: item.available !== false && remainingStock !== 0, remainingStock };
  }));
});

// GET /api/store-config - public kitchen and delivery rules
app.get('/api/store-config', async (req, res) => {
  const db = await getDb();
  const settings = getSettings(db.data);
  res.json({
    announcement: settings.announcement,
    orderingPaused: settings.orderingPaused,
    kitchenClosedDates: settings.kitchenClosedDates,
    lunchCutoffTime: settings.lunchCutoffTime,
    dinnerCutoffTime: settings.dinnerCutoffTime,
    deliveryTimeSlots: settings.deliveryTimeSlots,
    dailyOrderCapacity: settings.dailyOrderCapacity
  });
});

// PATCH /api/admin/menu/:id - update availability and daily stock
app.patch('/api/admin/menu/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const db = await getDb();
  const item = db.data.menu.find((candidate) => candidate.id === Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Menu item not found.' });
  const { available, dailyStock } = req.body || {};
  if (typeof available !== 'boolean') return res.status(400).json({ error: 'Availability must be true or false.' });
  if (dailyStock !== null && (!Number.isInteger(Number(dailyStock)) || Number(dailyStock) < 0)) {
    return res.status(400).json({ error: 'Daily stock must be a non-negative number or empty.' });
  }
  item.available = available;
  item.dailyStock = dailyStock === null ? null : Number(dailyStock);
  await db.write();
  res.json(item);
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
  if (!isValidDateString(date)) {
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
  res.json(getSettings(db.data));
});

// PATCH /api/admin/settings - update subscription settings (requires admin key)
app.patch('/api/admin/settings', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const input = req.body || {};
  const days = Number(input.subscriptionWorkingDays);
  if (!Number.isInteger(days) || days <= 0 || days > 365) {
    return res.status(400).json({ error: 'Subscription working days must be a positive number.' });
  }
  const db = await getDb();
  const settings = getSettings(db.data);
  const lunchCutoffTime = input.lunchCutoffTime ?? settings.lunchCutoffTime;
  const dinnerCutoffTime = input.dinnerCutoffTime ?? settings.dinnerCutoffTime;
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof lunchCutoffTime !== 'string' || typeof dinnerCutoffTime !== 'string' ||
      !validTime.test(lunchCutoffTime) || !validTime.test(dinnerCutoffTime) || lunchCutoffTime >= dinnerCutoffTime) {
    return res.status(400).json({ error: 'Enter valid IST cutoffs, with lunch earlier than dinner.' });
  }
  const updates = {
    subscriptionWorkingDays: days,
    announcement: typeof input.announcement === 'string' ? input.announcement.trim().slice(0, 240) : settings.announcement,
    orderingPaused: typeof input.orderingPaused === 'boolean' ? input.orderingPaused : settings.orderingPaused,
    kitchenClosedDates: Array.isArray(input.kitchenClosedDates) && input.kitchenClosedDates.every(isValidDateString) ? input.kitchenClosedDates : settings.kitchenClosedDates,
    dailyOrderCapacity: Number.isInteger(Number(input.dailyOrderCapacity)) && Number(input.dailyOrderCapacity) > 0 ? Number(input.dailyOrderCapacity) : settings.dailyOrderCapacity,
    lunchCutoffTime,
    dinnerCutoffTime,
    deliveryTimeSlots: Array.isArray(input.deliveryTimeSlots) && input.deliveryTimeSlots.length > 0 ? input.deliveryTimeSlots.filter(isValidTimeSlot) : settings.deliveryTimeSlots
  };
  db.data.settings = updates;
  await db.write();
  res.json(updates);
});

// GET /api/subscriptions/me - list the current user's admin-approved Monthly subscriptions
app.get('/api/subscriptions/me', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const result = db.data.subscriptions
    .filter((s) => s.userId === user.id && subscriptionInService(s, db.data))
    .map((subscription) => ({ ...subscription, ...buildSubscriptionSchedule(subscription, subscriptionHolidays(db.data)) }));

  res.json(result);
});

// POST /api/subscriptions/:id/skip - cancel one meal and carry it forward
app.post('/api/subscriptions/:id/skip', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const subscription = db.data.subscriptions.find((entry) => entry.id === req.params.id && entry.userId === user.id);
  if (!subscription || !subscription.approved) return res.status(404).json({ error: 'Active subscription not found.' });

  const { date, meal } = req.body || {};
  if (!isValidDateString(date) || !['lunch', 'dinner'].includes(meal)) {
    return res.status(400).json({ error: 'Choose a valid date and meal to skip.' });
  }
  const schedule = buildSubscriptionSchedule(subscription, subscriptionHolidays(db.data));
  const scheduledMeal = schedule.schedule.find((entry) => entry.date === date && entry.meal === meal);
  if (!scheduledMeal || scheduledMeal.status !== 'upcoming') {
    return res.status(409).json({ error: 'That meal is not an upcoming delivery in this subscription.' });
  }
  if (!canCancelSubscriptionMeal(date, meal)) {
    return res.status(409).json({ error: meal === 'lunch' ? 'Lunch can only be skipped before 11:00 AM IST on the same day.' : 'Dinner can only be skipped before 6:00 PM IST on the same day.' });
  }

  subscription.skippedMeals ||= [];
  subscription.skippedMeals.push({ date, meal, cancelledAt: new Date().toISOString() });
  await db.write();
  res.json({ ...subscription, ...buildSubscriptionSchedule(subscription, subscriptionHolidays(db.data)) });
});

// GET /api/admin/subscriptions - list every user's Monthly subscriptions (requires admin key)
app.get('/api/admin/subscriptions', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  const usersById = new Map(db.data.users.map((u) => [u.id, u]));
  const result = db.data.subscriptions.map((subscription) => {
    const schedule = buildSubscriptionSchedule(subscription, subscriptionHolidays(db.data));
    const user = usersById.get(subscription.userId);
    return {
      ...subscription,
      ...schedule,
      inService: subscriptionInService(subscription, db.data),
      customisation: subscription.customisation || db.data.orders.find((order) => order.id === subscription.orderId)?.items.find((item) => item.name === subscription.itemName)?.customisation || '',
      customerName: user?.name || 'Unknown',
      customerPhone: user?.phone || ''
    };
  });

  res.json(result);
});

// POST /api/admin/subscriptions - manually add an already-paid subscription
app.post('/api/admin/subscriptions', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const { userId, itemId, startDate } = req.body || {};
  const db = await getDb();
  const user = db.data.users.find((candidate) => candidate.id === Number(userId));
  if (!user) return res.status(404).json({ error: 'Registered user not found.' });
  const menuItem = db.data.menu.find((item) => item.id === Number(itemId));
  if (!menuItem || !menuItem.name.toLowerCase().startsWith('monthly')) {
    return res.status(400).json({ error: 'Choose a monthly package.' });
  }
  if (!isValidDateString(startDate)) return res.status(400).json({ error: 'Start date must be a valid YYYY-MM-DD date.' });

  const subscription = {
    id: crypto.randomBytes(12).toString('hex'),
    userId: user.id,
    orderId: null,
    itemName: menuItem.name,
    customisation: menuItem.customisations?.[0] || '',
    mealSlots: getSubscriptionMealSlots(menuItem.name),
    startDate,
    workingDaysRequired: getSettings(db.data).subscriptionWorkingDays,
    skippedMeals: [],
    approved: true,
    source: 'admin_manual',
    createdAt: new Date().toISOString()
  };
  db.data.subscriptions.push(subscription);
  await db.write();
  res.status(201).json({
    ...subscription,
    ...buildSubscriptionSchedule(subscription, subscriptionHolidays(db.data)),
    customerName: user.name,
    customerPhone: user.phone
  });
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
    if (!isValidDateString(startDate)) {
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

  res.json({ ...subscription, ...buildSubscriptionSchedule(subscription, subscriptionHolidays(db.data)) });
});

// PATCH /api/admin/subscriptions/:id/approve - make a pending subscription visible to the user (requires admin key)
app.patch('/api/admin/subscriptions/:id/approve', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  const subscription = db.data.subscriptions.find((s) => s.id === req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Subscription not found.' });
  const order = db.data.orders.find((entry) => entry.id === subscription.orderId);
  if (subscription.deactivated || (subscription.orderId && (!order || paymentStatus(order) !== 'verified' || ['cancelled', 'refund_requested', 'refunded'].includes(order.status)))) {
    return res.status(409).json({ error: 'Verify payment for an active order before approving this subscription.' });
  }
  if (!subscription.approved) {
    const today = todayISTStr();
    const slots = getSubscriptionMealSlots(subscription.itemName);
    const start = new Date(`${today}T00:00:00Z`);
    if (slots.some((meal) => !canCancelSubscriptionMeal(today, meal))) start.setUTCDate(start.getUTCDate() + 1);
    const earliestDate = start.toISOString().slice(0, 10);
    if (subscription.startDate < earliestDate) subscription.startDate = earliestDate;
    subscription.approvedAt = new Date().toISOString();
  }
  subscription.approved = true;
  await db.write();

  res.json({ ...subscription, ...buildSubscriptionSchedule(subscription, subscriptionHolidays(db.data)) });
});

// GET /api/admin/users - list all registered users (requires admin key)
app.get('/api/admin/users', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  res.json(db.data.users.map((user) => ({ ...publicUser(user), createdAt: user.createdAt })));
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

// GET /api/admin/password-reset-requests - list open reset requests
app.get('/api/admin/password-reset-requests', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const db = await getDb();
  const usersById = new Map(db.data.users.map((user) => [user.id, user]));
  const now = Date.now();
  const requests = (db.data.passwordResetRequests || [])
    .filter((entry) => entry.status !== 'completed')
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
    .map(({ keyHash, ...entry }) => ({
      ...entry,
      status: entry.status === 'key_issued' && entry.expiresAt <= now ? 'expired' : entry.status,
      customerName: usersById.get(entry.userId)?.name || 'Unknown',
      phone: usersById.get(entry.userId)?.phone || entry.phone
    }));
  res.json(requests);
});

// POST /api/admin/password-reset-requests/:id/issue-key - issue a one-time key for the user
app.post('/api/admin/password-reset-requests/:id/issue-key', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const db = await getDb();
  db.data.passwordResetRequests ||= [];
  const resetRequest = db.data.passwordResetRequests.find((entry) => entry.id === req.params.id);
  if (!resetRequest || resetRequest.status === 'completed') return res.status(404).json({ error: 'Open reset request not found.' });

  const now = Date.now();
  const resetKey = crypto.randomBytes(12).toString('hex').toUpperCase();
  const expiresAt = now + 30 * 60 * 1000;
  resetRequest.status = 'key_issued';
  resetRequest.keyHash = crypto.createHash('sha256').update(resetKey).digest('hex');
  resetRequest.issuedAt = new Date(now).toISOString();
  resetRequest.expiresAt = expiresAt;
  await db.write();
  res.json({ resetKey, expiresAt });
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
  const transitions = {
    pending_payment: ['cancelled'],
    payment_review: ['paid', 'cancelled'],
    paid: ['preparing', 'cancelled', 'refund_requested'],
    preparing: ['out_for_delivery', 'cancelled'],
    out_for_delivery: ['delivered'],
    delivered: ['refund_requested'],
    cancelled: ['refund_requested'],
    refund_requested: ['refunded'],
    refunded: []
  };
  if (!(transitions[order.status] || []).includes(status)) return res.status(409).json({ error: 'Invalid order status transition.' });
  if (['preparing', 'out_for_delivery', 'delivered', 'refund_requested', 'refunded'].includes(status) && paymentStatus(order) !== 'verified') {
    return res.status(409).json({ error: 'Verified payment is required for this action.' });
  }
  if (['preparing', 'out_for_delivery', 'delivered'].includes(status) && order.items.every((item) => item.name.toLowerCase().startsWith('monthly'))) {
    return res.status(409).json({ error: 'Monthly purchases use subscription approval, not delivery stages.' });
  }
  if (status === 'paid') {
    order.paymentStatus = 'verified';
    order.paymentVerifiedAt = new Date().toISOString();
  }
  if (['cancelled', 'refund_requested', 'refunded'].includes(status)) {
    order.paymentStatus = paymentStatus(order);
    deactivateSubscriptions(db.data, order);
  }
  order.status = status;
  order.statusUpdatedAt = new Date().toISOString();
  if (status === 'refunded') order.refundedAt = order.statusUpdatedAt;
  await db.write();
  const { accessToken, ...safeOrder } = order;
  res.json(safeOrder);
});

// POST /api/orders - place a new order
app.post('/api/orders', async (req, res) => {
  const { items, customer, subscriptionStartDate } = req.body || {};

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
  if (!validDeliveryDetails(customer)) return res.status(400).json({ error: 'Enter a flat/door number and valid 6-digit pincode.' });
  if ((customer.lat != null && (!Number.isFinite(customer.lat) || Math.abs(customer.lat) > 90)) ||
      (customer.lng != null && (!Number.isFinite(customer.lng) || Math.abs(customer.lng) > 180))) return res.status(400).json({ error: 'Invalid delivery coordinates.' });
  const db = await getDb();
  const settings = getSettings(db.data);
  if (settings.orderingPaused) return res.status(409).json({ error: 'Ordering is temporarily paused.' });
  const today = todayISTStr();
  if (settings.kitchenClosedDates.includes(today)) return res.status(409).json({ error: 'The kitchen is closed today.' });
  const menuById = new Map(db.data.menu.map((item) => [item.id, item]));
  const cutoffExempt = items.every((line) => {
    const menuItem = menuById.get(Number(line.id));
    return menuItem && (menuItem.name.toLowerCase().startsWith('monthly') || menuItem.id === 6);
  });
  const mealService = cutoffExempt ? null : getOrderMealService(settings);
  if (!cutoffExempt && !mealService) {
    return res.status(409).json({ error: `Single Meal orders close at ${settings.dinnerCutoffTime} IST. Lunch cutoff is ${settings.lunchCutoffTime} IST.` });
  }
  const requestedMeals = items.filter((line) => {
    const item = menuById.get(Number(line.id));
    return item?.category === 'Pure Veg Meals' && !item.name.toLowerCase().startsWith('monthly');
  }).reduce((total, line) => total + Number(line.quantity), 0);
  if (requestedMeals > 0 && kitchenMealCount(db.data, today) + requestedMeals > settings.dailyOrderCapacity) return res.status(409).json({ error: 'Kitchen capacity for today has been reached.' });

  const user = await getUserFromToken(db, req);
  const requiresAccount = items.some((line) => {
    const menuItem = menuById.get(Number(line.id));
    return menuItem && menuItem.name.toLowerCase().startsWith('monthly');
  });
  if (requiresAccount && !user) {
    return res.status(401).json({ error: 'Please sign up or log in to order Monthly packages.' });
  }
  const preferredStartDate = subscriptionStartDate ?? todayISTStr();
  if (requiresAccount && (!isValidDateString(preferredStartDate) || preferredStartDate < todayISTStr())) {
    return res.status(400).json({ error: 'Choose a valid subscription start date from today onward (IST).' });
  }

  let total = 0;
  const orderItems = [];
  for (const line of items) {
    const menuItem = menuById.get(Number(line.id));
    const quantity = Number(line.quantity);
    if (!menuItem || !Number.isInteger(quantity) || quantity <= 0 || quantity > 50) {
      return res.status(400).json({ error: 'Invalid item in cart.' });
    }
    if (menuItem.available === false) return res.status(409).json({ error: `${menuItem.name} is currently unavailable.` });
    const requestedForItem = items.filter((item) => Number(item.id) === menuItem.id).reduce((total, item) => total + Number(item.quantity), 0);
    if (menuItem.name.toLowerCase().startsWith('monthly') && requestedForItem !== 1) return res.status(400).json({ error: 'Order one subscription per monthly plan at a time.' });
    if (Number.isInteger(menuItem.dailyStock)) {
      if (stockUsed(db.data, today, menuItem.id) + requestedForItem > menuItem.dailyStock) return res.status(409).json({ error: `${menuItem.name} has reached its daily stock limit.` });
    }
    let customisation = '';
    let unitPrice = menuItem.price;
    if (Array.isArray(menuItem.variants) && menuItem.variants.length > 0) {
      const variant = menuItem.variants.find((option) => option.label === line.customisation);
      if (!variant) return res.status(400).json({ error: `Choose a valid size for ${menuItem.name}.` });
      customisation = variant.label;
      unitPrice = variant.price;
    } else if (Array.isArray(menuItem.customisations) && menuItem.customisations.length > 0) {
      if (!menuItem.customisations.includes(line.customisation)) {
        return res.status(400).json({ error: `Invalid customisation for ${menuItem.name}.` });
      }
      customisation = line.customisation;
    }
    total += unitPrice * quantity;
    orderItems.push({ id: menuItem.id, name: menuItem.name, price: unitPrice, quantity, customisation });
  }

  const orderId = crypto.randomBytes(6).readUIntBE(0, 6);
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
    mealService,
    scheduledDate: mealService ? today : null,
    timeSlot: mealService,
    customer: {
      name: customer.name.trim(),
      phone: customer.phone.trim(),
      address: customer.address.trim(),
      flatNumber: customer.flatNumber.trim(),
      pincode: customer.pincode.trim(),
      lat: Number.isFinite(customer.lat) ? customer.lat : null,
      lng: Number.isFinite(customer.lng) ? customer.lng : null
    },
    status: 'pending_payment',
    paymentStatus: 'unpaid',
    createdAt: new Date().toISOString()
  };

  db.data.orders.push(order);

  if (user) {
    const startDate = preferredStartDate;
    for (const item of orderItems) {
      if (item.name.toLowerCase().startsWith('monthly')) {
        db.data.subscriptions.push({
          id: `${order.id}-${item.id}`,
          userId: user.id,
          orderId: order.id,
          itemName: item.name,
          customisation: item.customisation,
          mealSlots: getSubscriptionMealSlots(item.name),
          startDate,
          workingDaysRequired: settings.subscriptionWorkingDays,
          skippedMeals: [],
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

// PATCH /api/orders/:id/mark-paid - mark an order as paid (called once user confirms payment)
app.patch('/api/orders/:id/mark-paid', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const user = await getUserFromToken(db, req);
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot update this order.' });
  if (order.status !== 'pending_payment') return res.status(409).json({ error: 'This order is no longer awaiting payment.' });
  if (!reservesStock(order)) return res.status(409).json({ error: 'This unpaid order has expired. Please place a new order.' });
  order.status = 'payment_review';
  order.paymentStatus = 'awaiting_verification';
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

// GET /api/orders/:id - fetch a single order's status
app.get('/api/orders/:id', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const user = await getUserFromToken(db, req);
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot access this order.' });
  const { accessToken, ...safeOrder } = order;
  res.json({ ...safeOrder, upiUri: `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${order.total}&cu=INR&tn=${encodeURIComponent('Order ' + order.id)}` });
});

// PATCH /api/orders/:id/cancel - customer cancellation before fulfillment
app.patch('/api/orders/:id/cancel', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  const user = await getUserFromToken(db, req);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot update this order.' });
  if (!['pending_payment', 'payment_review', 'paid'].includes(order.status)) return res.status(409).json({ error: 'This order can no longer be cancelled.' });
  order.paymentStatus = paymentStatus(order);
  order.status = 'cancelled';
  deactivateSubscriptions(db.data, order);
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
  if (paymentStatus(order) !== 'verified' || !['paid', 'cancelled', 'delivered'].includes(order.status)) return res.status(409).json({ error: 'This order is not eligible for a refund request.' });
  order.paymentStatus = 'verified';
  order.status = 'refund_requested';
  deactivateSubscriptions(db.data, order);
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
  if (paymentStatus(order) !== 'verified') return res.status(409).json({ error: 'Invoice is available after admin payment verification.' });

  const items = order.items.map((item) => ({ ...item, lineTotal: item.price * item.quantity }));

  res.json({
    invoiceNumber: `INV-${order.orderNumber || order.id}`,
    orderNumber: order.orderNumber || String(order.id),
    date: order.createdAt,
    status: order.status,
    scheduledDate: order.scheduledDate,
    timeSlot: order.timeSlot,
    business: BUSINESS,
    customer: order.customer,
    items,
    total: order.total
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'The request could not be completed. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
