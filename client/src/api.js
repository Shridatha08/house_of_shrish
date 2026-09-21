const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

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

export const getStoreConfig = () => request('/api/store-config');

export const placeOrder = (payload, token) =>
  request('/api/orders', { method: 'POST', body: JSON.stringify(payload), headers: authHeaders(token) });

function orderHeaders(token, accessToken) {
  return { ...authHeaders(token), ...(accessToken ? { 'x-order-token': accessToken } : {}) };
}

export const getOrder = (id, token, accessToken) =>
  request(`/api/orders/${id}`, { headers: orderHeaders(token, accessToken) });

export const markOrderPaid = (id, token, accessToken) =>
  request(`/api/orders/${id}/mark-paid`, { method: 'PATCH', headers: orderHeaders(token, accessToken) });

export const getInvoice = (id, token, accessToken) =>
  request(`/api/orders/${id}/invoice`, { headers: orderHeaders(token, accessToken) });

export const getMyOrders = (token) => request('/api/orders/me', { headers: authHeaders(token) });

export const cancelOrder = (id, token, accessToken) =>
  request(`/api/orders/${id}/cancel`, { method: 'PATCH', headers: orderHeaders(token, accessToken) });

export const requestRefund = (id, token, accessToken) =>
  request(`/api/orders/${id}/refund-request`, { method: 'POST', headers: orderHeaders(token, accessToken) });

export const registerUser = (payload) =>
  request('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });

export const loginUser = (payload) =>
  request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) });

export const verifyPasswordResetPhone = (userJsonUrl) =>
  request('/api/auth/password-reset/verify-phone', {
    method: 'POST',
    body: JSON.stringify({ userJsonUrl })
  });

export const resetPassword = (payload) =>
  request('/api/auth/password-reset', { method: 'POST', body: JSON.stringify(payload) });

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

export const approveAdminSubscription = (id, adminKey) =>
  request(`/api/admin/subscriptions/${id}/approve`, {
    method: 'PATCH',
    headers: { 'x-admin-key': adminKey }
  });

export const getAdminUsers = (adminKey) =>
  request('/api/admin/users', { headers: { 'x-admin-key': adminKey } });

export const deleteAdminUser = (id, adminKey) =>
  request(`/api/admin/users/${id}`, { method: 'DELETE', headers: { 'x-admin-key': adminKey } });

export const getAdminOrders = (adminKey) =>
  request('/api/admin/orders', { headers: { 'x-admin-key': adminKey } });

export const updateAdminOrderStatus = (id, status, adminKey) =>
  request(`/api/admin/orders/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
    headers: { 'x-admin-key': adminKey }
  });

export const updateAdminMenuItem = (id, payload, adminKey) =>
  request(`/api/admin/menu/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
    headers: { 'x-admin-key': adminKey }
  });
