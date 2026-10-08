// Phone pop-up notifications on this device: ask permission, register with the server, or switch off.
// Same file in FC Inspect (public/push.js) — keep the two in step.
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
// iPhone/iPad only allow web push for apps added to the Home Screen
export const needsInstall = () => /iPhone|iPad|iPod/.test(navigator.userAgent) && !(matchMedia('(display-mode: standalone)').matches || navigator.standalone);
const b64 = (s) => Uint8Array.from(atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}
export async function enablePush({ api, post }) {
  if (!pushSupported()) throw new Error(needsInstall() ? 'On iPhone, add the app to your Home Screen first (Share → Add to Home Screen), then open it from there.' : 'This browser can\'t show notifications.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this app — allow them in your phone\'s Settings.');
  const { key } = await api('/push/key');
  if (!key) throw new Error('Notifications aren\'t set up on the server yet.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  await post('/push/subscribe', sub.toJSON());
}
export async function disablePush({ post }) {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (!sub) return;
  await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
