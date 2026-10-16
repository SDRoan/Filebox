import React, { useRef } from 'react';
import { UploadIcon } from './Icons';
import './UploadButton.css';

interface UploadButtonProps {
  onFileSelect: (file: File) => void;
  label?: string;
}

const UploadButton: React.FC<UploadButtonProps> = ({ onFileSelect, label = 'Upload files' }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <>
      <button className="upload-button" onClick={handleClick}>
        <UploadIcon size={16} color="#ffffff" />
        <span>{label}</span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </>
  );
};

export default UploadButton;


