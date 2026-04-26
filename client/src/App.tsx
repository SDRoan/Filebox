import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Dashboard from './components/Dashboard';
import FileRequestUpload from './components/FileRequestUpload';
import './App.css';

const App: React.FC = () => {
  const { loading } = useAuth();

  if (loading) {
    return <div className="loading-screen">Loading...</div>;
  }

  return (
    <Router>
      <Routes>
        <Route
          path="/login"
          element={<Navigate to="/" replace />}
        />
        <Route
          path="/file-request/:requestId"
          element={<FileRequestUpload />}
        />
        <Route
          path="/*"
          element={<Dashboard />}
        />
      </Routes>
    </Router>
  );
};

export default App;
