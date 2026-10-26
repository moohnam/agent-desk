import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { installEmacsKeys } from './emacsKeys.ts';
import './styles.css';

installEmacsKeys();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
