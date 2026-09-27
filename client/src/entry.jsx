import React from 'react';
import ReactDOM from 'react-dom/client';
import InstanceGate from './instance/InstanceGate.jsx';
import './index.css';

const App = React.lazy(() => import('./app.jsx'));

ReactDOM.createRoot(document.getElementById('root')).render(<InstanceGate App={App} />);
