import { useState } from 'react';
import { Login } from './Login.jsx';
import { ChatApp } from './ChatApp.jsx';

export function App() {
  const [session, setSession] = useState(null);

  if (!session) {
    return <Login onAuthenticated={(username, password) => setSession({ username, password })} />;
  }

  return <ChatApp username={session.username} password={session.password} />;
}
