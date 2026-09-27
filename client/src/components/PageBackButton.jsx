import React from 'react';
import { ArrowLeft } from 'lucide-react';

export default function PageBackButton({ onClick, label = '返回', className = '', onHero = false }) {
  return <button type="button" onClick={onClick}
    className={`page-back-button${onHero ? ' page-back-button--hero' : ''} ${className}`.trim()}
    aria-label={label}>
    <ArrowLeft size={18} strokeWidth={1.8} aria-hidden="true" />
    <span>{label}</span>
  </button>;
}
