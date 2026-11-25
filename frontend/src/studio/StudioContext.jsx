import { createContext, useContext } from 'react';

export const StudioContext = createContext(null);

export function useStudio() {
  const value = useContext(StudioContext);
  if (!value) throw new Error('useStudio() must be used inside <StudioProvider>.');
  return value;
}
