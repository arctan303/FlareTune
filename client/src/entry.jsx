import React from 'react';
import ReactDOM from 'react-dom/client';
import InstanceGate from './instance/InstanceGate.jsx';
import './index.css';
import { languageReady } from './i18n/index.js';

const App = React.lazy(() => import('./app.jsx'));

void languageReady.then(() => ReactDOM.createRoot(document.getElementById('root')).render(<InstanceGate App={App} />));
