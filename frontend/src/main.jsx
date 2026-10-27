import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/schibsted-grotesk/wght.css';
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
