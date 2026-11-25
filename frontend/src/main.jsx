import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { StudioProvider } from './studio/StudioProvider.jsx';
import './styles.css';

// No StrictMode: its double-invoked mount effects would fire the session check and the workspace
// load twice against the real API on every dev reload.
createRoot(document.getElementById('root')).render(
  <StudioProvider>
    <App />
  </StudioProvider>,
);
