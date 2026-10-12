import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDb, saveResetSnapshot } from './db.js';
import { notifyAdmins, notifyAllCustomers, notifyOrder, notifyUser, pushDiagnostics, registerDeviceToken, removeDeviceToken } from './push.js';

const app = express();
const PORT = process.env.PORT || 4000;
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

const UPI_ID = 'houseofshrish@ybl';
const MERCHANT_NAME = 'House of Shrish';

// Malleshpalya kitchen. Override with env vars to set an exact rooftop pin.
const KITCHEN_LAT = Number(process.env.KITCHEN_LAT ?? 12.9744129);
const KITCHEN_LNG = Number(process.env.KITCHEN_LNG ?? 77.6743533);
const DELIVERY_RADIUS_KM = Number(process.env.DELIVERY_RADIUS_KM ?? 4);
const OUT_OF_RANGE_MESSAGE = 'Sorry Unavailable in your area. We are working to deliver soon!';
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
// Deliberately loose: Indian mobile carriers put many real customers behind one
// NAT address, so this is only a backstop against a flood. The per-customer cap
// on unsettled orders is what actually protects kitchen capacity.
const orderRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
// An unpaid order holds a meal slot, so a handful of them can exhaust the day's
// capacity and lock out paying customers.
const MAX_UNSETTLED_ORDERS = Number(process.env.MAX_UNSETTLED_ORDERS ?? 3);
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
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    address: user.address || '',
    flatNumber: user.flatNumber || '',
    pincode: user.pincode || '',
    lat: typeof user.lat === 'number' ? user.lat : null,
    lng: typeof user.lng === 'number' ? user.lng : null
  };
}

// Coordinates are optional everywhere; absent is valid, malformed is not.
function readCoordinates(source) {
  const lat = source?.lat;
  const lng = source?.lng;
  if (lat === undefined || lat === null || lng === undefined || lng === null) {
    return { ok: true, lat: null, lng: null };
  }
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
    return { ok: false };
  }
  return { ok: true, lat, lng };
}

// Great-circle distance in km.
function distanceFromKitchenKm(lat, lng) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat - KITCHEN_LAT);
  const dLng = toRad(lng - KITCHEN_LNG);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(KITCHEN_LAT)) * Math.cos(toRad(lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Meals are cooked fresh and hand-delivered; sweets ship anywhere.
function requiresLocalDelivery(menuItem) {
  return menuItem?.category === 'Pure Veg Meals';
}

function getDriverFromToken(data, req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const session = (data.driverSessions || []).find((entry) => entry.token === token);
  if (!session) return null;
  if (Date.now() - new Date(session.createdAt).getTime() >= 30 * 24 * 60 * 60 * 1000) return null;
  const driver = (data.drivers || []).find((entry) => entry.id === session.driverId);
  return driver && driver.active !== false ? driver : null;
}

function publicDriver(driver) {
  return { id: driver.id, name: driver.name, phone: driver.phone, active: driver.active !== false };
}

function distanceBetweenKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

/// Nearest-neighbour from the kitchen, then 2-opt to undo the crossings that
/// greedy ordering leaves behind. Exact TSP is unnecessary at this size.
function optimiseRoute(stops, origin = { lat: KITCHEN_LAT, lng: KITCHEN_LNG }) {
  const located = stops.filter((stop) => stop.lat !== null && stop.lng !== null);
  const unlocated = stops.filter((stop) => stop.lat === null || stop.lng === null);

  const remaining = [...located];
  const route = [];
  let cursor = origin;
  while (remaining.length > 0) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = distanceBetweenKm(cursor, remaining[i]);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    cursor = remaining[best];
    route.push(remaining.splice(best, 1)[0]);
  }

  const legLength = (list) => {
    let total = 0;
    let from = origin;
    for (const stop of list) {
      total += distanceBetweenKm(from, stop);
      from = stop;
    }
    return total;
  };

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        const candidate = [...route];
        candidate.splice(i, j - i + 1, ...route.slice(i, j + 1).reverse());
        if (legLength(candidate) < legLength(route) - 1e-9) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  // Stops without coordinates cannot be sequenced, so they go last.
  let from = origin;
  const sequenced = route.map((stop, index) => {
    const legKm = distanceBetweenKm(from, stop);
    from = stop;
    return { ...stop, sequence: index + 1, legKm: Number(legKm.toFixed(2)) };
  });
  return [
    ...sequenced,
    ...unlocated.map((stop, index) => ({ ...stop, sequence: sequenced.length + index + 1, legKm: null }))
  ];
}

// Everything the kitchen owes a customer today: one-off orders plus the day's
// subscription meals, which are delivered without an order being placed.
function buildRunStops(data, today) {
  const usersById = new Map(data.users.map((entry) => [entry.id, entry]));
  const stops = [];

  for (const order of data.orders) {
    const scheduled = order.scheduledDate || businessDate(order.createdAt);
    if (scheduled !== today) continue;
    if (!['paid', 'preparing', 'out_for_delivery'].includes(order.status)) continue;
    if (paymentStatus(order) !== 'verified') continue;
    stops.push({
      kind: 'order',
      id: String(order.id),
      reference: `#${order.orderNumber}`,
      customerName: order.customer.name,
      customerPhone: order.customer.phone,
      address: order.customer.address,
      flatNumber: order.customer.flatNumber || '',
      pincode: order.customer.pincode || '',
      lat: order.customer.lat ?? null,
      lng: order.customer.lng ?? null,
      items: order.items.map((item) => `${item.quantity}× ${item.name}`),
      status: order.status,
      delivered: order.status === 'delivered'
    });
  }

  for (const subscription of data.subscriptions) {
    if (!subscriptionInService(subscription, data)) continue;
    const schedule = buildSubscriptionSchedule(subscription, subscriptionHolidays(data));
    const dueToday = schedule.schedule.filter((entry) => entry.date === today && entry.status !== 'skipped');
    if (dueToday.length === 0) continue;
    const customer = usersById.get(subscription.userId);
    if (!customer) continue;
    const deliveredMeals = subscription.deliveredMeals || [];
    for (const meal of dueToday) {
      const alreadyDelivered = deliveredMeals.some((entry) => entry.date === meal.date && entry.meal === meal.meal);
      stops.push({
        kind: 'subscription',
        id: `${subscription.id}:${meal.date}:${meal.meal}`,
        reference: subscription.itemName,
        customerName: customer.name,
        customerPhone: customer.phone,
        address: customer.address,
        flatNumber: customer.flatNumber || '',
        pincode: customer.pincode || '',
        lat: customer.lat ?? null,
        lng: customer.lng ?? null,
        items: [`1× ${meal.meal === 'dinner' ? 'Dinner' : 'Lunch'}${subscription.customisation ? ` · ${subscription.customisation}` : ''}`],
        status: alreadyDelivered ? 'delivered' : 'pending',
        delivered: alreadyDelivered
      });
    }
  }

  return stops;
}

// A driver who has not reported in for this long is treated as offline rather
// than shown frozen on the customer's map.
const DRIVER_FIX_MAX_AGE_MS = Number(process.env.DRIVER_FIX_MAX_AGE_MS ?? 5 * 60 * 1000);
const AVERAGE_SPEED_KMPH = Number(process.env.AVERAGE_SPEED_KMPH ?? 18);
const STOP_SERVICE_MINUTES = Number(process.env.STOP_SERVICE_MINUTES ?? 3);
// Straight-line distance understates road distance; this is the usual city fudge.
const ROAD_DETOUR_FACTOR = Number(process.env.ROAD_DETOUR_FACTOR ?? 1.35);

function driverFix(driver, now = Date.now()) {
  const fix = driver?.location;
  if (!fix || typeof fix.lat !== 'number' || typeof fix.lng !== 'number') return null;
  if (now - new Date(fix.at).getTime() > DRIVER_FIX_MAX_AGE_MS) return null;
  return fix;
}

// Stops are shared across drivers, so an explicit assignment wins and otherwise
// the one driver currently reporting a position is the one out delivering.
function trackingDriver(data, order) {
  const drivers = (data.drivers || []).filter((entry) => entry.active !== false);
  if (order.driverId) {
    const assigned = drivers.find((entry) => entry.id === order.driverId);
    return assigned && driverFix(assigned) ? assigned : null;
  }
  const live = drivers.filter((entry) => driverFix(entry));
  return live.length === 1 ? live[0] : null;
}

function estimateArrival(data, order, fix) {
  const destination = readCoordinates(order.customer);
  const hasDestination = destination.ok && destination.lat !== null;
  const direct = hasDestination ? distanceBetweenKm(fix, destination) : null;

  const route = optimiseRoute(buildRunStops(data, todayISTStr()).filter((stop) => !stop.delivered), fix);
  const index = route.findIndex((stop) => stop.kind === 'order' && stop.id === String(order.id));

  // Not in today's run (or no pin on file): fall back to a direct estimate.
  if (index < 0 || route[index].legKm === null) {
    if (direct === null) return { destination: null, stopsAway: null, distanceKm: null, etaMinutes: null };
    return {
      destination: { lat: destination.lat, lng: destination.lng },
      stopsAway: null,
      distanceKm: Number(direct.toFixed(2)),
      etaMinutes: Math.max(1, Math.round((direct * ROAD_DETOUR_FACTOR) / AVERAGE_SPEED_KMPH * 60))
    };
  }

  const alongRoute = route.slice(0, index + 1).reduce((total, stop) => total + (stop.legKm || 0), 0);
  const driving = (alongRoute * ROAD_DETOUR_FACTOR) / AVERAGE_SPEED_KMPH * 60;
  return {
    destination: { lat: route[index].lat, lng: route[index].lng },
    stopsAway: index,
    distanceKm: Number(alongRoute.toFixed(2)),
    etaMinutes: Math.max(1, Math.round(driving + index * STOP_SERVICE_MINUTES))
  };
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

function subscriptionCoverage(data, userId) {
  const covered = new Set();
  for (const subscription of data.subscriptions) {
    if (subscription.userId !== userId || subscription.deactivated) continue;
    if (subscription.orderId) {
      const order = data.orders.find((entry) => entry.id === subscription.orderId);
      if (!order || !reservesStock(order)) continue;
    } else if (!subscription.approved) continue;
    const schedule = buildSubscriptionSchedule(subscription, subscriptionHolidays(data));
    if (!schedule.endDate || schedule.endDate < todayISTStr()) continue;
    for (const meal of schedule.mealSlots) covered.add(meal);
  }
  return covered;
}

function monthlyCoverageConflict(data, userId, monthlyItems) {
  const covered = subscriptionCoverage(data, userId);
  for (const item of monthlyItems) {
    const meals = getSubscriptionMealSlots(item.name);
    const conflict = meals.find((meal) => covered.has(meal));
    if (conflict) return `You already have an active or pending ${conflict} subscription. Choose only a meal you do not have.`;
    for (const meal of meals) covered.add(meal);
  }
  return null;
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

function subscriptionCarryForwardDeadline(startDate, originalEndDate, holidays) {
  const original = new Date(`${originalEndDate}T00:00:00Z`);
  const monthStart = new Date(Date.UTC(original.getUTCFullYear(), original.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
  monthStart.setUTCDate(Math.min(original.getUTCDate(), lastDay));
  const baseDeadline = monthStart.toISOString().slice(0, 10);
  const holidayDates = [...new Set(holidays.map((holiday) => holiday.date))]
    .filter((date) => isValidDateString(date) && date >= startDate)
    .sort();
  const deadline = new Date(`${baseDeadline}T00:00:00Z`);
  for (const date of holidayDates) {
    if (date > deadline.toISOString().slice(0, 10)) break;
    deadline.setUTCDate(deadline.getUTCDate() + 1);
  }
  return deadline.toISOString().slice(0, 10);
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

  const originalEndDate = computeSubscriptionEndDate(subscription.startDate, requiredDays, holidays);
  if (!originalEndDate) {
    return { mealSlots, schedule: [], endDate: null, daysRemaining: 0, remainingMeals: 0, expiresToday: false, expired: true };
  }
  const carryForwardDeadline = subscriptionCarryForwardDeadline(subscription.startDate, originalEndDate, holidays);

  const skipped = new Set((subscription.skippedMeals || []).map((entry) => `${entry.date}:${entry.meal}`));
  const delivered = new Set((subscription.deliveredMeals || []).map((entry) => `${entry.date}:${entry.meal}`));
  const requiredMeals = requiredDays * mealSlots.length;
  // Counts meals placed on the calendar, which is not the same as the meals the
  // driver has actually handed over.
  let scheduledMeals = 0;
  const schedule = [];
  const cursor = new Date(`${subscription.startDate}T00:00:00Z`);
  let endDate = null;
  const maxDays = Math.min(10000, Math.max(730, (requiredDays + skipped.size + 10) * 3));

  for (let offset = 0; offset < maxDays; offset++) {
    const date = cursor.toISOString().slice(0, 10);
    if (date > carryForwardDeadline) break;
    if (isWorkingDay(date, holidays)) {
      for (const meal of mealSlots) {
        if (scheduledMeals >= requiredMeals) break;
        const key = `${date}:${meal}`;
        if (skipped.has(key)) {
          schedule.push({ date, meal, status: 'skipped', canCancel: false });
          continue;
        }
        const status = delivered.has(key) ? 'delivered' : date < today ? 'elapsed' : 'upcoming';
        schedule.push({ date, meal, status, canCancel: status === 'upcoming' && canCancelSubscriptionMeal(date, meal) });
        scheduledMeals++;
        endDate = date;
      }
      if (scheduledMeals >= requiredMeals) break;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const upcomingEntries = schedule.filter((entry) => entry.status === 'upcoming');
  const daysRemaining = new Set(upcomingEntries.map((entry) => entry.date)).size;
  const remainingMeals = upcomingEntries.length;
  const mealsBeyondDeadline = Math.max(0, requiredMeals - scheduledMeals);
  if (mealsBeyondDeadline > 0) endDate = carryForwardDeadline;
  return {
    mealSlots,
    schedule,
    endDate,
    originalEndDate,
    carryForwardDeadline,
    mealsBeyondDeadline,
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
  const coordinates = readCoordinates(req.body);
  if (!coordinates.ok) return res.status(400).json({ error: 'Invalid delivery coordinates.' });
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
    lat: coordinates.lat,
    lng: coordinates.lng,
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
  if (!user) {
    return res.status(401).json({ error: 'User not registered. Please register first.' });
  }
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect password. Please try again.' });
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

// Orders stay on the books for accounting, stripped of anything identifying.
function purgeUserData(data, userId) {
  for (const order of data.orders) {
    if (order.userId !== userId) continue;
    order.userId = null;
    delete order.accessToken;
    order.customer = { name: 'Deleted account', phone: '', address: '', flatNumber: '', pincode: '', lat: null, lng: null };
  }
  data.users = data.users.filter((entry) => entry.id !== userId);
  data.sessions = data.sessions.filter((entry) => entry.userId !== userId);
  data.subscriptions = data.subscriptions.filter((entry) => entry.userId !== userId);
  data.deviceTokens = (data.deviceTokens || []).filter((entry) => entry.userId !== userId);
  data.passwordResetRequests = (data.passwordResetRequests || []).filter((entry) => entry.userId !== userId);
}

// DELETE /api/auth/me - customer-initiated account deletion, required by Play
app.delete('/api/auth/me', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  // Deleting mid-delivery would strand food already paid for and in transit.
  const inFlight = db.data.orders.some((order) =>
    order.userId === user.id && ['payment_review', 'paid', 'preparing', 'out_for_delivery'].includes(order.status));
  if (inFlight) {
    return res.status(409).json({ error: 'You have an order in progress. Please wait until it is delivered, or cancel it, before deleting your account.' });
  }

  purgeUserData(db.data, user.id);
  await db.write();
  res.status(204).end();
});

// POST /api/device-token - register this device for customer push notifications
app.post('/api/device-token', async (req, res) => {
  const db = await getDb();
  const user = await getUserFromToken(db, req);

  const { token, platform, orderId } = req.body || {};
  if (typeof token !== 'string' || token.trim().length < 20 || token.length > 4096) {
    return res.status(400).json({ error: 'A valid device token is required.' });
  }

  // Guests have no account, so they prove ownership with the order's access token.
  let boundOrderId = null;
  if (!user) {
    const order = db.data.orders.find((entry) => entry.id === Number(orderId));
    if (!order || !order.accessToken || order.accessToken !== getOrderToken(req)) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    boundOrderId = order.id;
  }

  registerDeviceToken(db.data, {
    token: token.trim(),
    userId: user?.id ?? null,
    orderId: boundOrderId,
    platform
  });
  await db.write();
  res.status(204).end();
});

// DELETE /api/device-token - stop sending notifications to this device
app.delete('/api/device-token', async (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'A device token is required.' });
  }
  const db = await getDb();
  removeDeviceToken(db.data, token.trim());
  await db.write();
  res.status(204).end();
});

// POST /api/admin/device-token - register an admin console device
app.post('/api/admin/device-token', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const { token, platform } = req.body || {};
  if (typeof token !== 'string' || token.trim().length < 20 || token.length > 4096) {
    return res.status(400).json({ error: 'A valid device token is required.' });
  }
  const db = await getDb();
  registerDeviceToken(db.data, { token: token.trim(), isAdmin: true, platform });
  await db.write();
  res.status(204).end();
});

// --- Drivers ---------------------------------------------------------------

// GET /api/admin/drivers - list delivery drivers (requires admin key)
app.get('/api/admin/drivers', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const db = await getDb();
  res.json((db.data.drivers || []).map(publicDriver));
});

// POST /api/admin/drivers - create a driver login (requires admin key)
app.post('/api/admin/drivers', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const { name, phone, password } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Driver name is required.' });
  if (typeof phone !== 'string' || !/^\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ error: 'A valid 10-digit phone number is required.' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const db = await getDb();
  db.data.drivers ||= [];
  if (db.data.drivers.some((entry) => entry.phone === phone.trim())) {
    return res.status(409).json({ error: 'A driver with this phone number already exists.' });
  }
  const driver = {
    id: crypto.randomBytes(6).readUIntBE(0, 6),
    name: name.trim(),
    phone: phone.trim(),
    passwordHash: await bcrypt.hash(password, 10),
    active: true,
    createdAt: new Date().toISOString()
  };
  db.data.drivers.push(driver);
  await db.write();
  res.status(201).json(publicDriver(driver));
});

// DELETE /api/admin/drivers/:id - revoke a driver and their sessions
app.delete('/api/admin/drivers/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const db = await getDb();
  const driverId = Number(req.params.id);
  const before = (db.data.drivers || []).length;
  db.data.drivers = (db.data.drivers || []).filter((entry) => entry.id !== driverId);
  if (db.data.drivers.length === before) return res.status(404).json({ error: 'Driver not found.' });
  db.data.driverSessions = (db.data.driverSessions || []).filter((entry) => entry.driverId !== driverId);
  await db.write();
  res.status(204).end();
});

// POST /api/driver/login - authenticate a driver
app.post('/api/driver/login', authRateLimit, async (req, res) => {
  const { phone, password } = req.body || {};
  if (typeof phone !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Phone number and password are required.' });
  }
  const db = await getDb();
  const driver = (db.data.drivers || []).find((entry) => entry.phone === phone.trim());
  if (!driver || driver.active === false || !(await bcrypt.compare(password, driver.passwordHash))) {
    return res.status(401).json({ error: 'Invalid phone number or password.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.data.driverSessions ||= [];
  db.data.driverSessions.push({ token, driverId: driver.id, createdAt: new Date().toISOString() });
  await db.write();
  res.json({ driver: publicDriver(driver), token });
});

// POST /api/driver/logout - revoke this driver session
app.post('/api/driver/logout', async (req, res) => {
  const db = await getDb();
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  db.data.driverSessions = (db.data.driverSessions || []).filter((entry) => entry.token !== token);
  await db.write();
  res.status(204).end();
});

// POST /api/driver/location - the driver app's position ping while on a run
app.post('/api/driver/location', async (req, res) => {
  const db = await getDb();
  const driver = getDriverFromToken(db.data, req);
  if (!driver) return res.status(401).json({ error: 'Not signed in.' });

  const point = readCoordinates(req.body);
  if (!point.ok || point.lat === null) return res.status(400).json({ error: 'A valid latitude and longitude are required.' });

  driver.location = { lat: point.lat, lng: point.lng, at: new Date().toISOString() };
  await db.write();
  res.status(204).end();
});

// DELETE /api/driver/location - stop sharing position when the run ends
app.delete('/api/driver/location', async (req, res) => {
  const db = await getDb();
  const driver = getDriverFromToken(db.data, req);
  if (!driver) return res.status(401).json({ error: 'Not signed in.' });
  delete driver.location;
  await db.write();
  res.status(204).end();
});

// GET /api/driver/deliveries - today's run, sequenced shortest-first
app.get('/api/driver/deliveries', async (req, res) => {
  const db = await getDb();
  const driver = getDriverFromToken(db.data, req);
  if (!driver) return res.status(401).json({ error: 'Not signed in.' });

  const today = todayISTStr();
  const stops = buildRunStops(db.data, today);
  const pending = optimiseRoute(stops.filter((stop) => !stop.delivered));
  const done = stops.filter((stop) => stop.delivered).map((stop) => ({ ...stop, sequence: null, legKm: null }));
  res.json({
    driver: publicDriver(driver),
    date: today,
    kitchen: { lat: KITCHEN_LAT, lng: KITCHEN_LNG },
    stops: [...pending, ...done]
  });
});

// POST /api/driver/deliveries/:id/delivered - complete a stop
app.post('/api/driver/deliveries/:id/delivered', async (req, res) => {
  const db = await getDb();
  const driver = getDriverFromToken(db.data, req);
  if (!driver) return res.status(401).json({ error: 'Not signed in.' });

  const stopId = String(req.params.id);
  const [subscriptionId, date, meal] = stopId.split(':');

  if (date && meal) {
    const subscription = db.data.subscriptions.find((entry) => entry.id === subscriptionId);
    if (!subscription) return res.status(404).json({ error: 'Delivery not found.' });
    subscription.deliveredMeals ||= [];
    const already = subscription.deliveredMeals.some((entry) => entry.date === date && entry.meal === meal);
    if (!already) {
      subscription.deliveredMeals.push({ date, meal, deliveredAt: new Date().toISOString(), driverId: driver.id });
      await db.write();
    }
    return res.status(204).end();
  }

  const order = db.data.orders.find((entry) => entry.id === Number(stopId));
  if (!order) return res.status(404).json({ error: 'Delivery not found.' });
  if (!['paid', 'preparing', 'out_for_delivery'].includes(order.status)) {
    return res.status(409).json({ error: 'This order is not out for delivery.' });
  }
  order.status = 'delivered';
  order.statusUpdatedAt = new Date().toISOString();
  order.deliveredBy = driver.id;
  await db.write();

  await notifyOrder(db, order, {
    title: 'Delivered',
    body: `Order #${order.orderNumber} has been delivered. Enjoy your meal!`,
    data: { type: 'order_status', orderId: order.id, status: 'delivered' }
  });
  res.status(204).end();
});

// GET /api/admin/push-status - why notifications are or are not being delivered
app.get('/api/admin/push-status', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const db = await getDb();
  res.json(pushDiagnostics(db.data));
});

// POST /api/admin/broadcast - send a promotional notification to every customer
app.post('/api/admin/broadcast', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!title || title.length > 60) {
    return res.status(400).json({ error: 'Enter a title of up to 60 characters.' });
  }
  if (!body || body.length > 180) {
    return res.status(400).json({ error: 'Enter a message of up to 180 characters.' });
  }

  const db = await getDb();
  const recipients = await notifyAllCustomers(db, {
    title,
    body,
    data: { type: 'promotion' }
  });
  res.json({ recipients });
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
  const coordinates = readCoordinates(req.body);
  if (!coordinates.ok) return res.status(400).json({ error: 'Invalid delivery coordinates.' });

  user.name = name.trim();
  user.phone = phone.trim();
  user.address = address.trim();
  user.flatNumber = flatNumber.trim();
  user.pincode = pincode.trim();
  // Omitting coordinates leaves any previously saved pin untouched.
  if (coordinates.lat !== null) {
    user.lat = coordinates.lat;
    user.lng = coordinates.lng;
  }
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
    dailyOrderCapacity: settings.dailyOrderCapacity,
    kitchenLat: KITCHEN_LAT,
    kitchenLng: KITCHEN_LNG,
    deliveryRadiusKm: DELIVERY_RADIUS_KM
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
  if (date > schedule.carryForwardDeadline) {
    return res.status(409).json({ error: 'Cannot be carry forwarded beyond this date' });
  }
  const scheduledMeal = schedule.schedule.find((entry) => entry.date === date && entry.meal === meal);
  if (!scheduledMeal || scheduledMeal.status !== 'upcoming') {
    return res.status(409).json({ error: 'That meal is not an upcoming delivery in this subscription.' });
  }
  if (!canCancelSubscriptionMeal(date, meal)) {
    return res.status(409).json({ error: meal === 'lunch' ? 'Lunch can only be skipped before 11:00 AM IST on the same day.' : 'Dinner can only be skipped before 6:00 PM IST on the same day.' });
  }

  const skippedMeals = [...(subscription.skippedMeals || []), { date, meal, cancelledAt: new Date().toISOString() }];
  const projectedSchedule = buildSubscriptionSchedule({ ...subscription, skippedMeals }, subscriptionHolidays(db.data));
  if (projectedSchedule.mealsBeyondDeadline > 0) {
    return res.status(409).json({ error: 'Cannot be carry forwarded beyond this date' });
  }
  subscription.skippedMeals = skippedMeals;
  await db.write();

  // Only same-day skips change what the kitchen cooks today.
  if (date === todayISTStr()) {
    const customer = db.data.users.find((entry) => entry.id === subscription.userId);
    await notifyAdmins(db, {
      title: 'Meal skipped today',
      body: `${customer?.name || 'A customer'} skipped ${meal} for today (${subscription.itemName}).`,
      data: { type: 'meal_skipped', subscriptionId: subscription.id, date, meal }
    });
  }

  res.json({ ...subscription, ...projectedSchedule });
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
  const coverageConflict = monthlyCoverageConflict(db.data, user.id, [menuItem]);
  if (coverageConflict) return res.status(409).json({ error: coverageConflict });

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

// POST /api/admin/subscriptions/:id/meal - correct a past or missed meal.
// A customer's own skip is bound by same-day cutoffs, but the kitchen needs to
// fix a delivery that never happened, and that is always in the past.
app.post('/api/admin/subscriptions/:id/meal', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid admin key.' });
  }
  const db = await getDb();
  const subscription = db.data.subscriptions.find((s) => s.id === req.params.id);
  if (!subscription) return res.status(404).json({ error: 'Subscription not found.' });

  const { date, meal, skipped, status } = req.body || {};
  if (!isValidDateString(date) || !['lunch', 'dinner'].includes(meal)) {
    return res.status(400).json({ error: 'Choose a valid date and meal.' });
  }
  // `skipped` is the older two-state form kept for installed admin builds.
  const next = status ?? (skipped === true ? 'skipped' : skipped === false ? 'pending' : undefined);
  if (!['delivered', 'skipped', 'pending'].includes(next)) {
    return res.status(400).json({ error: 'Set the meal to delivered, skipped or pending.' });
  }
  if (date < subscription.startDate) {
    return res.status(400).json({ error: 'That date is before the subscription started.' });
  }
  if (next === 'delivered' && date > todayISTStr()) {
    return res.status(400).json({ error: 'A meal cannot be marked delivered before its date.' });
  }

  const now = new Date().toISOString();
  subscription.skippedMeals = (subscription.skippedMeals || []).filter((entry) => !(entry.date === date && entry.meal === meal));
  subscription.deliveredMeals = (subscription.deliveredMeals || []).filter((entry) => !(entry.date === date && entry.meal === meal));
  if (next === 'skipped') {
    subscription.skippedMeals.push({ date, meal, cancelledAt: now, byAdmin: true });
  } else if (next === 'delivered') {
    subscription.deliveredMeals.push({ date, meal, deliveredAt: now, byAdmin: true });
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

  await notifyUser(db, subscription.userId, {
    title: 'Subscription approved',
    body: `Your ${subscription.itemName} is active from ${subscription.startDate}.`,
    data: { type: 'subscription_approved', subscriptionId: subscription.id }
  });

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
  purgeUserData(db.data, userId);
  if (db.data.users.length === before) {
    return res.status(404).json({ error: 'User not found.' });
  }
  await db.write();
  res.status(204).end();
});

// POST /api/admin/reset - erase customer, driver and order history (requires admin key)
app.post('/api/admin/reset', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key.' });
  if ((req.body || {}).confirm !== 'ERASE') {
    return res.status(400).json({ error: 'Type ERASE to confirm this cannot be undone.' });
  }

  const db = await getDb();
  const counts = {
    orders: db.data.orders.length,
    subscriptions: db.data.subscriptions.length,
    users: db.data.users.length,
    drivers: (db.data.drivers || []).length
  };

  const snapshotId = await saveResetSnapshot({
    takenAt: new Date().toISOString(),
    orders: db.data.orders,
    subscriptions: db.data.subscriptions,
    users: db.data.users,
    drivers: db.data.drivers || [],
    deviceTokens: db.data.deviceTokens || []
  });

  db.data.orders = [];
  db.data.subscriptions = [];
  db.data.users = [];
  db.data.sessions = [];
  db.data.passwordResetRequests = [];
  db.data.drivers = [];
  db.data.driverSessions = [];
  // Admin devices keep their registration, or this console would go silent
  // until someone reopened it.
  db.data.deviceTokens = (db.data.deviceTokens || []).filter((entry) => entry.isAdmin);

  await db.write();
  res.json({ ...counts, snapshotId });
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

  const announcements = {
    paid: ['Payment confirmed', `We have verified your payment for order #${order.orderNumber}.`],
    preparing: ['Order being prepared', `Order #${order.orderNumber} is now being prepared.`],
    out_for_delivery: ['Out for delivery', `Order #${order.orderNumber} is on its way.`],
    delivered: ['Delivered', `Order #${order.orderNumber} has been delivered. Enjoy your meal!`]
  };
  const announcement = announcements[status];
  if (announcement) {
    await notifyOrder(db, order, {
      title: announcement[0],
      body: announcement[1],
      data: { type: 'order_status', orderId: order.id, status }
    });
  }

  const { accessToken, ...safeOrder } = order;
  res.json(safeOrder);
});

// Orders that are still holding stock without having been paid for. A signed-in
// customer is matched on their account; a guest on the phone number they gave.
function unsettledOrders(data, user, phone) {
  return data.orders.filter((order) => {
    if (!['pending_payment', 'payment_review'].includes(order.status)) return false;
    if (!reservesStock(order)) return false;
    return user ? order.userId === user.id : !order.userId && order.customer?.phone === phone;
  });
}

// POST /api/orders - place a new order
app.post('/api/orders', orderRateLimit, async (req, res) => {
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

  // Meals are delivered from the kitchen, so they are limited by distance.
  // Sweets are not, and a sweets-only order needs no pin at all.
  const needsLocalDelivery = items.some((line) => requiresLocalDelivery(menuById.get(Number(line.id))));
  if (needsLocalDelivery) {
    if (customer.lat == null || customer.lng == null) {
      return res.status(400).json({ error: 'Pin your delivery location on the map to order meals.' });
    }
    if (distanceFromKitchenKm(customer.lat, customer.lng) > DELIVERY_RADIUS_KM) {
      return res.status(409).json({ error: OUT_OF_RANGE_MESSAGE });
    }
  }
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

  const unsettled = unsettledOrders(db.data, user, customer.phone.trim());
  if (unsettled.length >= MAX_UNSETTLED_ORDERS) {
    return res.status(429).json({ error: `You have ${unsettled.length} orders still awaiting payment. Please pay or cancel one before placing another.` });
  }

  const requiresAccount = items.some((line) => {
    const menuItem = menuById.get(Number(line.id));
    return menuItem && menuItem.name.toLowerCase().startsWith('monthly');
  });
  if (requiresAccount && !user) {
    return res.status(401).json({ error: 'Please sign up or log in to order Monthly packages.' });
  }
  if (requiresAccount) {
    const monthlyItems = items.map((line) => menuById.get(Number(line.id)))
      .filter((item) => item && item.name.toLowerCase().startsWith('monthly'));
    const coverageConflict = monthlyCoverageConflict(db.data, user.id, monthlyItems);
    if (coverageConflict) return res.status(409).json({ error: coverageConflict });
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

  const newSubscriptions = orderItems.filter((item) => item.name.toLowerCase().startsWith('monthly'));
  await notifyAdmins(db, {
    title: newSubscriptions.length > 0 ? 'New subscription order' : 'New order',
    body: `#${order.orderNumber} · ₹${total} · ${order.customer.name}` +
      (newSubscriptions.length > 0 ? ` · ${newSubscriptions.map((item) => item.name).join(', ')} awaiting approval` : ''),
    data: {
      type: newSubscriptions.length > 0 ? 'new_subscription' : 'new_order',
      orderId: order.id,
      orderNumber: order.orderNumber
    }
  });

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

  // Nothing moves until an admin verifies this, so it has to be announced.
  await notifyAdmins(db, {
    title: 'Payment awaiting verification',
    body: `#${order.orderNumber} · ₹${order.total} · ${order.customer.name} submitted payment.`,
    data: { type: 'payment_review', orderId: order.id, orderNumber: order.orderNumber }
  });

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

// GET /api/orders/:id/track - live driver position and ETA for the customer
app.get('/api/orders/:id/track', async (req, res) => {
  const db = await getDb();
  const order = db.data.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const user = await getUserFromToken(db, req);
  if (!canAccessOrder(order, user, req)) return res.status(403).json({ error: 'You cannot track this order.' });

  // A driver's position is only ever exposed while they are actually carrying
  // this customer's food.
  if (order.status !== 'out_for_delivery') {
    return res.json({ status: order.status, trackable: false, driver: null, destination: null, stopsAway: null, distanceKm: null, etaMinutes: null });
  }

  const driver = trackingDriver(db.data, order);
  const fix = driverFix(driver);
  if (!fix) {
    return res.json({ status: order.status, trackable: false, driver: driver ? { name: driver.name, phone: driver.phone } : null, destination: null, stopsAway: null, distanceKm: null, etaMinutes: null });
  }

  const estimate = estimateArrival(db.data, order, fix);
  res.json({
    status: order.status,
    trackable: true,
    driver: { name: driver.name, phone: driver.phone, lat: fix.lat, lng: fix.lng, updatedAt: fix.at },
    ...estimate
  });
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
