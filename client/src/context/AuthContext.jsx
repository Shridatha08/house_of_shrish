import { createContext, useContext, useEffect, useState } from 'react';
import { registerUser, loginUser, getCurrentUser } from '../api';

const AuthContext = createContext(null);
const STORAGE_KEY = 'houseOfShrishAuth';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      setReady(true);
      return;
    }
    const { token: savedToken } = JSON.parse(saved);
    getCurrentUser(savedToken)
      .then(({ user: savedUser }) => {
        setUser(savedUser);
        setToken(savedToken);
      })
      .catch(() => localStorage.removeItem(STORAGE_KEY))
      .finally(() => setReady(true));
  }, []);

  function persist(nextUser, nextToken) {
    setUser(nextUser);
    setToken(nextToken);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: nextToken }));
  }

  async function register(payload) {
    const { user: newUser, token: newToken } = await registerUser(payload);
    persist(newUser, newToken);
  }

  async function login(payload) {
    const { user: loggedInUser, token: newToken } = await loginUser(payload);
    persist(loggedInUser, newToken);
  }

  function logout() {
    setUser(null);
    setToken(null);
    localStorage.removeItem(STORAGE_KEY);
  }

  function updateUser(nextUser) {
    setUser(nextUser);
  }

  const value = { user, token, ready, register, login, logout, updateUser };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
