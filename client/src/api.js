const API_BASE = 'http://localhost:4000';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Something went wrong.');
  }
  return data;
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export const getMenu = () => request('/api/menu');

export const placeOrder = (payload, token) =>
  request('/api/orders', { method: 'POST', body: JSON.stringify(payload), headers: authHeaders(token) });

export const getOrder = (id) => request(`/api/orders/${id}`);

export const markOrderPaid = (id) =>
  request(`/api/orders/${id}/mark-paid`, { method: 'PATCH' });

export const getInvoice = (id) => request(`/api/orders/${id}/invoice`);

export const registerUser = (payload) =>
  request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });

export const loginUser = (payload) =>
  request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });

export const updateProfile = (payload, token) =>
  request('/api/auth/profile', { method: 'PATCH', body: JSON.stringify(payload), headers: authHeaders(token) });

export const getCurrentUser = (token) =>
  request('/api/auth/me', { headers: authHeaders(token) });

export const getHolidays = () => request('/api/holidays');

export const addHoliday = (payload, adminKey) =>
  request('/api/holidays', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'x-admin-key': adminKey }
  });

export const deleteHoliday = (id, adminKey) =>
  request(`/api/holidays/${id}`, { method: 'DELETE', headers: { 'x-admin-key': adminKey } });

export const verifyAdminKey = (adminKey) =>
  request('/api/admin/verify', { headers: { 'x-admin-key': adminKey } });

export const getMySubscriptions = (token) =>
  request('/api/subscriptions/me', { headers: authHeaders(token) });

export const getAdminSettings = (adminKey) =>
  request('/api/admin/settings', { headers: { 'x-admin-key': adminKey } });

export const updateAdminSettings = (payload, adminKey) =>
  request('/api/admin/settings', {
    method: 'PATCH',
    body: JSON.stringify(payload),
    headers: { 'x-admin-key': adminKey }
  });

export const getAdminSubscriptions = (adminKey) =>
  request('/api/admin/subscriptions', { headers: { 'x-admin-key': adminKey } });

export const updateAdminSubscription = (id, payload, adminKey) =>
  request(`/api/admin/subscriptions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
    headers: { 'x-admin-key': adminKey }
  });
