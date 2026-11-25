import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../studio/StudioContext.jsx';

export function SignInGate() {
  const { authRequired, signIn } = useStudio();
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const tokenRef = useRef(null);

  // On opening: clear the previous attempt's message and focus the token field (as the plain-HTML
  // studio did).
  useEffect(() => {
    if (!authRequired) return;
    setError('');
    tokenRef.current?.focus();
  }, [authRequired]);

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError('Enter the API token.');
      return;
    }

    setError('Checking the token…');
    try {
      await signIn({ token: trimmed, name: name.trim() });
      setToken('');
    } catch (failure) {
      setError(failure.message);
    }
  };

  return (
    <div className="auth-gate" id="auth-gate" hidden={!authRequired}>
      <form className="auth-card" onSubmit={submit}>
        <h2>Sign in to YT AutoPilot</h2>
        <p className="hint">
          Every API call needs the token. Find it in <code>backend/.api-token</code>, or set
          <code>API_TOKEN</code> in <code>backend/.env</code> and restart the server.
        </p>
        <label className="field">
          <span>API token</span>
          <input
            ref={tokenRef}
            type="password"
            autoComplete="current-password"
            required
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Your name (recorded when you approve)</span>
          <input
            type="text"
            autoComplete="name"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="meta" id="auth-error" role="alert">
          {error}
        </p>
        <button className="btn primary" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
