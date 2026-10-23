import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { AppearanceProvider } from './context/AppearanceContext';
import { CompanionProvider } from './context/CompanionContext';
import { applyAccent, storedAccent } from './theme/accent';
import { applyAppearance, applyBackgroundImage, storedAppearance, storedBackgroundImage } from './theme/appearance';

// The color and look chosen in Settings, applied before anything is drawn.
applyAccent(storedAccent());
applyAppearance(storedAppearance());
applyBackgroundImage(storedBackgroundImage());

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <AuthProvider>
      <AppearanceProvider>
        <CompanionProvider>
          <App />
        </CompanionProvider>
      </AppearanceProvider>
    </AuthProvider>
  </React.StrictMode>
);
