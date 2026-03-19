import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import ComexDetails from './pages/ComexDetails';
import CBTracker from './pages/CBTracker';
import MiningSynergy from './pages/MiningSynergy';

export default function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/comex" element={<ComexDetails />} />
          <Route path="/cb-tracker" element={<CBTracker />} />
          <Route path="/mining-synergy" element={<MiningSynergy />} />
        </Routes>
      </Layout>
    </Router>
  );
}
