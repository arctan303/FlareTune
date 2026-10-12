import { createDemoData } from './localData.js';
export const demoData = createDemoData();
export const runtimeFetch = (input, init) => demoData.handle(input, init);
