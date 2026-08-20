import { createContext, useState, useEffect, useCallback } from 'react';
import * as authService from '../services/authService';

/**
 * AuthContext
 *
 * Provides global authentication state across the entire React application.
 *
 * Exposes:
 *   user     – currently authenticated user (null if not logged in)
 *   loading  – true while verifying token on app mount (prevents flash redirect)
 *   login    – authenticates user through the HttpOnly session cookie
 *   register – authenticates user through the HttpOnly session cookie
 *   logout   – invalidates the server-side cookie
 *
 */

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authService.getCurrentUser().then((data) => setUser(data.data.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  // ─── Login ─────────────────────────────────────────────────────────────────
  const login = useCallback(async ({ email, password }) => {
    const data = await authService.login({ email, password });
    setUser(data.data.user);
    return data;
  }, []);

  // ─── Register ──────────────────────────────────────────────────────────────
  const register = useCallback(async ({ name, email, password, confirmPassword }) => {
    const data = await authService.register({ name, email, password, confirmPassword });
    setUser(data.data.user);
    return data;
  }, []);

  // ─── Logout ────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    try { await authService.logout(); } finally { setUser(null); }
  }, []);

  const value = { user, loading, login, register, logout };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
