import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-semi-condensed/600.css';
import './styles.css';
import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { errMsg, type Me } from './api';
import { ErrorNote, Shell } from './components/Layout';
import { CampaignsPage } from './pages/Campaigns';
import { JourneysPage } from './pages/Journeys';
import { LivePage } from './pages/Live';
import { LoginPage } from './pages/Login';
import { ModelsPage } from './pages/Models';
import { OverviewPage } from './pages/Overview';
import { SetupPage } from './pages/Setup';
import { AppProvider, loadMe, useHashRoute } from './state';

const PAGES: Record<string, (params: URLSearchParams) => ReactNode> = {
  '/': () => <OverviewPage />,
  '/kampagnen': (params) => <CampaignsPage params={params} />,
  '/journeys': (params) => <JourneysPage params={params} />,
  '/modelle': () => <ModelsPage />,
  '/live': () => <LivePage />,
  '/einrichtung': () => <SetupPage />,
};

function Router() {
  const [path, params] = useHashRoute();
  const route = Object.hasOwn(PAGES, path) ? path : '/';
  return <Shell route={route}>{PAGES[route](params)}</Shell>;
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const refresh = useCallback(async () => setMe(await loadMe()), []);
  const start = useCallback(() => {
    setLoadError(null);
    refresh().catch((err: unknown) => setLoadError(errMsg(err)));
  }, [refresh]);

  useEffect(() => {
    start();
    const onLogout = () => setMe(null);
    window.addEventListener('bezzify:logout', onLogout);
    return () => window.removeEventListener('bezzify:logout', onLogout);
  }, [start]);

  if (me === undefined) {
    if (!loadError) return null;
    return (
      <div className="login">
        <div className="login-card">
          <ErrorNote error={loadError} />
          <button className="btn" type="button" onClick={start}>
            Erneut versuchen
          </button>
        </div>
      </div>
    );
  }
  if (me === null) return <LoginPage onLogin={refresh} />;
  if (!me.sites.length) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>Noch kein Shop angelegt</h1>
          <p className="secondary">
            Lege per Kommandozeile einen Shop an: <code>npm run cli -- setup</code> oder für eine Vorschau <code>npm run demo</code>.
          </p>
        </div>
      </div>
    );
  }
  return (
    <AppProvider me={me} reloadMe={refresh}>
      <Router />
    </AppProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
