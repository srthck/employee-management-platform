import React from 'react';
import ReactDOM from 'react-dom/client';
// Apple's faces cannot be self-hosted, so the stack in styles/tokens.css asks
// for the system face first and falls back to Inter. The `opsz` build carries
// Inter's optical-size axis, which `font-optical-sizing: auto` then drives.
import '@fontsource-variable/inter/opsz.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import App from './App';

/**
 * React Entry Point
 * Renders App component to DOM
 */

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
