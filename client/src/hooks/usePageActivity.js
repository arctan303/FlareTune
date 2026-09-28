import React from 'react';

export const PageActivityContext = React.createContext(true);
export const usePageActivity = () => React.useContext(PageActivityContext);
