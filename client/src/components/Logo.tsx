import React from 'react';
import './Logo.css';

interface LogoProps {
  size?: 'small' | 'medium' | 'large';
  showText?: boolean;
  text?: string;
}

const Logo: React.FC<LogoProps> = ({ size = 'medium', showText = true, text = 'File Box' }) => {
  const sizeClasses = {
    small: 'logo-small',
    medium: 'logo-medium',
    large: 'logo-large'
  };

  return (
    <div className={`logo-container ${sizeClasses[size]}`}>
      <svg className="logo-img" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M5 10.5 16 5l11 5.5v12L16 28 5 22.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="m5 10.5 11 5.7 11-5.7M16 16v12M10.5 7.8l11 5.7v5.7" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
      {showText && (
        <span className="logo-text">{text}</span>
      )}
    </div>
  );
};

export default Logo;

