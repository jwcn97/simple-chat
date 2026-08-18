import { useState } from 'react';
import { login, signup } from './api.js';
import { LogoIcon, ErrorIcon } from './Icons.jsx';

export function Login({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await signup(username, password);
      }
      await login(username, password);
      onAuthenticated(username, password);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-brand">
          <LogoIcon size={40} />
          <h1 className="serif">Keeper</h1>
          <p className="login-tagline">a quiet place to talk</p>
        </div>

        <div className="tab-toggle">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(null); }}>
            Log in
          </button>
          <button type="button" className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(null); }}>
            Sign up
          </button>
        </div>

        <div className="login-form">
          <div className="field-group">
            <div className="field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                className={error ? 'invalid' : ''}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <div className="error-message">
                <ErrorIcon />
                {error}
              </div>
            )}
          </div>

          <button type="submit" className="primary-button serif" disabled={submitting || !username || !password}>
            {submitting ? 'One moment…' : mode === 'signup' ? 'Sign up' : 'Log in'}
          </button>
        </div>
      </form>
    </div>
  );
}
