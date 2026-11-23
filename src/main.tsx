import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { watchForStalePage } from './lib/staleClientGuard';
import { AppProvider } from './state/AppStore';
import { ThemeProvider } from './theme/ThemeProvider';
import './styles/tokens.css';
import './styles/glass.css';
import './styles/app.css';

watchForStalePage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </ThemeProvider>
  </StrictMode>,
);
