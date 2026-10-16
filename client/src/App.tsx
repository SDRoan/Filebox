import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import FileRequestUpload from './components/FileRequestUpload';
import SharedLinkPage from './components/SharedLinkPage';
import { legacyPaths, removedPaths } from './config/workspaceNavigation';
import './App.css';

const App: React.FC = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="loading-screen">Loading...</div>;
  }

  return (
    <Router>
      <Routes>
        {removedPaths.map(path => (
          <Route key={path} path={`${path}/*`} element={<Navigate to="/" replace />} />
        ))}
        {Object.entries(legacyPaths).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
        <Route
          path="/login"
          element={user ? <Navigate to="/" /> : <Login />}
        />
        <Route path="/s/:shareId" element={<SharedLinkPage />} />
        <Route
          path="/file-request/:requestId"
          element={<FileRequestUpload />}
        />
        <Route
          path="/*"
          element={user ? <Dashboard /> : <Navigate to="/login" />}
        />
      </Routes>
    </Router>
  );
};

export default App;
