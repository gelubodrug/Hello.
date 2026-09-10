import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import './styles/tokens.css';
import './styles/typography.css';
import './styles/motion.css';
import './styles/app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
