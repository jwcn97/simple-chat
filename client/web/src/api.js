const AUTH_URL = import.meta.env.VITE_AUTH_URL || 'http://localhost:4000';

async function authRequest(path, body) {
  const res = await fetch(`${AUTH_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `request failed (${res.status})`);
  }
  return data;
}

export function signup(username, password) {
  return authRequest('/signup', { username, password });
}

export function login(username, password) {
  return authRequest('/login', { username, password });
}
