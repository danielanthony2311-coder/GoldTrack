import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import PhysicalSupply from './pages/PhysicalSupply';
import Positioning from './pages/Positioning';
import PatternLibrary from './pages/PatternLibrary';
import ComexDetails from './pages/ComexDetails';
import CBTracker from './pages/CBTracker';
import MiningSynergy from './pages/MiningSynergy';
import LogViewer from './pages/LogViewer';

export default function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/supply" element={<PhysicalSupply />} />
          <Route path="/positioning" element={<Positioning />} />
          <Route path="/patterns" element={<PatternLibrary />} />
          <Route path="/comex" element={<ComexDetails />} />
          <Route path="/cb-tracker" element={<CBTracker />} />
          <Route path="/mining-synergy" element={<MiningSynergy />} />
          <Route path="/logs" element={<LogViewer />} />
        </Routes>
      </Layout>
    </Router>
  );
}
