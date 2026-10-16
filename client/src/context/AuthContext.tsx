import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from '../types';
import { authAPI } from '../services/api';
import { LOCAL_PREVIEW_ENABLED } from '../config/localPreview';

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<{ email: string }>;
  verifyCode: (email: string, code: string) => Promise<void>;
  resendCode: (email: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  loading: boolean;
  isLocalPreview: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const LOCAL_PREVIEW_USER: User = {
  id: 'local-preview',
  email: 'preview@filebox.test',
  name: 'Local workspace',
  storageUsed: 0,
  storageLimit: 10 * 1024 * 1024 * 1024,
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(LOCAL_PREVIEW_ENABLED ? LOCAL_PREVIEW_USER : null);
  const [token, setToken] = useState<string | null>(LOCAL_PREVIEW_ENABLED ? null : localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      if (LOCAL_PREVIEW_ENABLED) {
        try {
          const response = await authAPI.localSession();
          setUser(response.user);
          setToken(response.token);
        } catch (error) {
          console.error('Could not connect to local workspace:', error);
        } finally {
          setLoading(false);
        }
        return;
      }
      const storedToken = localStorage.getItem('token');
      if (storedToken) {
        try {
          const response = await authAPI.getCurrentUser();
          setUser(response.user);
          setToken(storedToken);
          setLoading(false);
          return;
        } catch (error) {
          localStorage.removeItem('token');
          setToken(null);
        }
      }
      setLoading(false);
    };
    initAuth();
  }, []);

  const login = async (email: string, password: string) => {
    try {
      const response = await authAPI.login(email, password);
      localStorage.setItem('token', response.token);
      setToken(response.token);
      setUser(response.user);
    } catch (error: any) {
      console.error('Login error in AuthContext:', error);
      throw error; // Re-throw to let Login component handle it
    }
  };

  const register = async (email: string, password: string, name: string) => {
    const response = await authAPI.register(email, password, name);
    // If token is returned, user was created directly (email service not configured)
    if (response.token) {
      localStorage.setItem('token', response.token);
      setToken(response.token);
      setUser(response.user);
      return { email: '' };
    }
    // Otherwise, return email for verification step
    return { email: response.email };
  };

  const verifyCode = async (email: string, code: string) => {
    const response = await authAPI.verifyCode(email, code);
    localStorage.setItem('token', response.token);
    setToken(response.token);
    setUser(response.user);
  };

  const resendCode = async (email: string) => {
    await authAPI.resendCode(email);
  };

  const refreshUser = async () => {
    try {
      const response = await authAPI.getCurrentUser();
      setUser(response.user);
    } catch (error) {
      console.error('Could not refresh workspace storage:', error);
    }
  };

  const logout = () => {
    if (LOCAL_PREVIEW_ENABLED) return;
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, register, verifyCode, resendCode, logout, refreshUser, loading, isLocalPreview: LOCAL_PREVIEW_ENABLED }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

