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
 *   login    – authenticates user, persists token, updates state
 *   register – creates account, persists token, updates state
 *   logout   – clears token and user state
 *
 * Portfolio implementation:
 * Token stored in localStorage for simplicity.
 * Production systems should prefer HttpOnly Secure Cookies.
 */

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true); // true until we resolve token

  // ─── On Mount: Verify existing token ──────────────────────────────────────
  // If a token exists in localStorage, fetch /auth/me to confirm it is valid.
  // This keeps the user logged in after a browser refresh.
  useEffect(() => {
    const restoreSession = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const data = await authService.getCurrentUser();
        setUser(data.data.user);
      } catch {
        // Token invalid or expired – clean up silently
        localStorage.removeItem('token');
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    restoreSession();
  }, []);

  // ─── Login ─────────────────────────────────────────────────────────────────
  const login = useCallback(async ({ email, password }) => {
    const data = await authService.login({ email, password });
    localStorage.setItem('token', data.data.token);
    setUser(data.data.user);
    return data;
  }, []);

  // ─── Register ──────────────────────────────────────────────────────────────
  const register = useCallback(async ({ name, email, password, confirmPassword }) => {
    const data = await authService.register({ name, email, password, confirmPassword });
    localStorage.setItem('token', data.data.token);
    setUser(data.data.user);
    return data;
  }, []);

  // ─── Logout ────────────────────────────────────────────────────────────────
  const logout = useCallback(() => {
    localStorage.removeItem('token');
    setUser(null);
  }, []);

  const value = { user, loading, login, register, logout };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
