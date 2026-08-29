import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@truefoundry/trueforge-ui/styles.css';
import './styles.css';
import App from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Operator root element is missing.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
