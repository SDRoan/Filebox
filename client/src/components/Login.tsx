import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { authAPI } from '../services/api';
import Logo from './Logo';
import './Login.css';

const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState('');
  const [verificationStep, setVerificationStep] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [isResending, setIsResending] = useState(false);
  const [forgotPasswordStep, setForgotPasswordStep] = useState<'request' | 'reset' | null>(null);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const { login, register, verifyCode, resendCode } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');

    try {
      if (forgotPasswordStep === 'request') {
        const result = await authAPI.forgotPassword(email);
        setPendingEmail(result.email || email);
        setForgotPasswordStep('reset');
        setSuccessMessage(result.message || 'If an account exists for that email, a password reset code has been sent.');
      } else if (forgotPasswordStep === 'reset') {
        if (!resetCode || resetCode.length !== 6) {
          setError('Please enter a valid 6-digit reset code');
          return;
        }
        if (newPassword.length < 6) {
          setError('Password must be at least 6 characters long');
          return;
        }
        if (newPassword !== confirmPassword) {
          setError('Passwords do not match');
          return;
        }
        const result = await authAPI.resetPassword(pendingEmail || email, resetCode, newPassword);
        setSuccessMessage(result.message || 'Password reset successfully. You can now sign in.');
        setForgotPasswordStep(null);
        setIsLogin(true);
        setPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setResetCode('');
      } else if (isLogin) {
        await login(email, password);
        navigate('/');
      } else {
        if (verificationStep) {
          // Verify code
          if (!verificationCode || verificationCode.length !== 6) {
            setError('Please enter a valid 6-digit code');
            return;
          }
          await verifyCode(pendingEmail, verificationCode);
          navigate('/');
        } else {
          // Step 1: Register and send verification code
          if (!name) {
            setError('Name is required');
            return;
          }
          const result = await register(email, password, name);
          // If email is returned, we need verification
          if (result.email) {
            setPendingEmail(result.email);
            setVerificationStep(true);
          } else {
            // If no email returned, account was created directly (email service not configured)
            navigate('/');
          }
        }
      }
    } catch (err: any) {
      console.error('Auth error:', err);
      if (err.response?.data?.message) {
        setError(err.response.data.message);
      } else if (err.message) {
        setError(err.message);
      } else if (err.code === 'ERR_NETWORK' || err.code === 'ECONNREFUSED') {
        setError('Cannot connect to server. Please check if the server is running.');
      } else {
        setError('An error occurred. Please try again.');
      }
    }
  };

  const handleResendCode = async () => {
    try {
      setIsResending(true);
      setError('');
      await resendCode(pendingEmail);
      setError('');
      alert('Verification code resent! Please check your email.');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to resend code. Please try again.');
    } finally {
      setIsResending(false);
    }
  };

  const handleBackToRegister = () => {
    setVerificationStep(false);
    setVerificationCode('');
    setPendingEmail('');
    setError('');
  };

  const handleBackToSignIn = () => {
    setForgotPasswordStep(null);
    setVerificationStep(false);
    setVerificationCode('');
    setResetCode('');
    setNewPassword('');
    setConfirmPassword('');
    setPendingEmail('');
    setError('');
    setSuccessMessage('');
    setIsLogin(true);
  };

  const handleResendResetCode = async () => {
    try {
      setIsResending(true);
      setError('');
      setSuccessMessage('');
      const result = await authAPI.forgotPassword(pendingEmail || email);
      setSuccessMessage(result.message || 'Password reset code resent. Please check your email.');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to resend reset code. Please try again.');
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-header">
          <Logo size="large" showText={true} text="File Box" />
          <p>
            {forgotPasswordStep === 'request'
              ? 'Reset your password'
              : forgotPasswordStep === 'reset'
                ? 'Check your email'
                : isLogin
              ? 'Sign in to your account'
              : verificationStep
                ? 'Verify your email'
                : 'Create a new account'}
          </p>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          {forgotPasswordStep === 'request' ? (
            <>
              <div className="verification-info">
                <p>Enter the email you use to sign in. We'll send a 6-digit reset code if the account exists.</p>
              </div>
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="login-input"
                autoFocus
              />
              {error && <div className="error-message">{error}</div>}
              {successMessage && <div className="success-message">{successMessage}</div>}
              <button type="submit" className="login-button">
                Send Reset Code
              </button>
              <button
                type="button"
                onClick={handleBackToSignIn}
                className="back-button-link"
              >
                Back to Sign In
              </button>
            </>
          ) : forgotPasswordStep === 'reset' ? (
            <>
              <div className="verification-info">
                <p>We've sent a 6-digit password reset code to:</p>
                <p className="verification-email">{pendingEmail || email}</p>
                <p className="verification-hint">Enter the code and choose a new password.</p>
              </div>
              <div className="verification-code-input">
                <input
                  type="text"
                  placeholder="000000"
                  value={resetCode}
                  onChange={(e) => {
                    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setResetCode(value);
                    setError('');
                  }}
                  className="login-input code-input"
                  maxLength={6}
                  autoFocus
                />
              </div>
              <input
                type="password"
                placeholder="New Password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                className="login-input"
              />
              <input
                type="password"
                placeholder="Confirm New Password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="login-input"
              />
              {error && <div className="error-message">{error}</div>}
              {successMessage && <div className="success-message">{successMessage}</div>}
              <button type="submit" className="login-button">
                Reset Password
              </button>
              <div className="verification-actions">
                <button
                  type="button"
                  onClick={handleResendResetCode}
                  disabled={isResending}
                  className="resend-button"
                >
                  {isResending ? 'Sending...' : 'Resend Code'}
                </button>
                <button
                  type="button"
                  onClick={handleBackToSignIn}
                  className="back-button-link"
                >
                  Back to Sign In
                </button>
              </div>
            </>
          ) : verificationStep ? (
            <>
              <div className="verification-info">
                <p>We've sent a 6-digit verification code to:</p>
                <p className="verification-email">{pendingEmail}</p>
                <p className="verification-hint">Please check your email and enter the code below.</p>
              </div>
              <div className="verification-code-input">
                <input
                  type="text"
                  placeholder="000000"
                  value={verificationCode}
                  onChange={(e) => {
                    const value = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setVerificationCode(value);
                    setError('');
                  }}
                  className="login-input code-input"
                  maxLength={6}
                  autoFocus
                />
              </div>
              {error && <div className="error-message">{error}</div>}
              <button type="submit" className="login-button">
                Verify & Create Account
              </button>
              <div className="verification-actions">
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={isResending}
                  className="resend-button"
                >
                  {isResending ? 'Sending...' : 'Resend Code'}
                </button>
                <button
                  type="button"
                  onClick={handleBackToRegister}
                  className="back-button-link"
                >
                  Back to Registration
                </button>
              </div>
            </>
          ) : (
            <>
              {!isLogin && (
                <input
                  type="text"
                  placeholder="Full Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="login-input"
                />
              )}
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="login-input"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="login-input"
              />
              {error && <div className="error-message">{error}</div>}
              {successMessage && <div className="success-message">{successMessage}</div>}
              <button type="submit" className="login-button">
                {isLogin ? 'Sign In' : 'Sign Up'}
              </button>
              {isLogin && (
                <button
                  type="button"
                  onClick={() => {
                    setForgotPasswordStep('request');
                    setError('');
                    setSuccessMessage('');
                    setPassword('');
                  }}
                  className="forgot-password-button"
                >
                  Forgot password?
                </button>
              )}
            </>
          )}
        </form>
        <div className="login-footer">
          {!verificationStep && !forgotPasswordStep && (
            <button
              type="button"
              onClick={() => {
                setIsLogin(!isLogin);
                setError('');
                setSuccessMessage('');
                setVerificationStep(false);
                setVerificationCode('');
                setPendingEmail('');
              }}
              className="toggle-button"
            >
              {isLogin ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Login;
