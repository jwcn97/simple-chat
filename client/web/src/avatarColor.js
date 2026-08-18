// A fixed hash-of-username palette, so the same person always gets the
// same avatar color everywhere in the app — the exact bug the mockup
// review caught (Bob rendering in two different colors on one screen).
const PALETTE = ['#c1602e', '#9c7c4e', '#b8923a', '#8a6a52', '#a8724a'];

export function avatarColorFor(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}
