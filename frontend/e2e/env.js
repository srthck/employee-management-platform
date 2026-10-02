// Ports and database used only by the browser end-to-end suite, so it never
// touches the development servers (5000 / 5173) or the development database.
export const BACKEND_PORT = 5100;
export const FRONTEND_PORT = 5174;
export const API = `http://localhost:${BACKEND_PORT}/api`;
export const E2E_MONGO_URI =
  process.env.E2E_MONGO_URI || 'mongodb://127.0.0.1:27018/payguard_e2e?replicaSet=rs0';
