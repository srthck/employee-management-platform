import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import './index.css';
import Home from './pages/Home';

/**
 * Main App Component
 * 
 * Routing structure:
 * - / → Home (foundation status)
 * - /dashboard → Dashboard (future)
 * - /employees → Employee management (future)
 * - /auth → Authentication (future)
 */

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* Routes will be added as features are built */}
      </Routes>
    </Router>
  );
}
