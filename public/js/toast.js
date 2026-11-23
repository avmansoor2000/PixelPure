const root = () => document.getElementById('toasts');

export function toast({ title, message = '', type = 'info', timeout = 5000 }) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const dot = document.createElement('span');
  dot.className = 't-dot';
  const body = document.createElement('div');
  const t = document.createElement('strong');
  t.textContent = title;
  body.append(t);
  if (message) {
    const p = document.createElement('p');
    p.textContent = message;
    body.append(p);
  }
  const close = document.createElement('button');
  close.className = 't-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  el.append(dot, body, close);
  root().append(el);

  const dismiss = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  close.addEventListener('click', dismiss);
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}

export const toastError = (err, title = 'Something went wrong') =>
  toast({ title, message: err && err.message ? err.message : String(err), type: 'error', timeout: 8000 });
