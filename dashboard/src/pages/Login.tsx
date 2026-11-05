import { useState, type FormEvent } from 'react';
import { api, errMsg } from '../api';
import { ErrorNote, Logo } from '../components/Layout';

export function LoginPage({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/login', { method: 'POST', body: { email, password } });
      await onLogin();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand" style={{ padding: 0 }}>
          <Logo size={34} />
          <span className="brand-name" style={{ fontSize: 26 }}>
            Bezzify
          </span>
        </div>
        <p className="secondary">Tracking und Attribution für deinen Shop. Melde dich mit deinem Zugang an.</p>
        <form className="panel" onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="email">Mailadresse</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="password">Passwort</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <ErrorNote error={error} />
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Anmeldung läuft' : 'Anmelden'}
          </button>
        </form>
      </div>
    </div>
  );
}
