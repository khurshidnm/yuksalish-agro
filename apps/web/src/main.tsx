import '@fontsource-variable/onest';
import './index.css';
import './lib/i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { Toaster } from 'sonner';
import { router } from './app/router';
import { ThemeProvider, useTheme } from './app/theme';
import { ConfirmProvider } from './components/ConfirmDialog';
import { TooltipProvider } from './components/ui';
import { registerServiceWorker } from './features/today/pwa';
import { OfflineRuntime } from './features/today/runtime';
import { AuthProvider } from './lib/auth';
import { queryClient } from './lib/query';

function AppToaster() {
  const { resolved } = useTheme();
  return <Toaster theme={resolved} position="top-center" richColors closeButton duration={4000} />;
}

// Not in development: a worker caching Vite's modules would serve stale code.
if (import.meta.env.PROD) registerServiceWorker();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <OfflineRuntime />
          <TooltipProvider>
            <ConfirmProvider>
              <RouterProvider router={router} />
            </ConfirmProvider>
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
      <AppToaster />
    </ThemeProvider>
  </StrictMode>,
);
