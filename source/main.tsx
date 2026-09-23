import React from 'react';
import {createRoot} from 'react-dom/client';
import Workspace from './app/workspace';
import './app/globals.css';
createRoot(document.getElementById('root')!).render(<Workspace/>);
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(r=>r.update()).catch(()=>{});
