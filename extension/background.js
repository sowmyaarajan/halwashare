/* HalwaShare extension.
   - The toolbar button opens HalwaShare, or brings its tab to the front.
   - Right-click a picture, link, selected text or the page itself to send
     it: it is kept here for a moment, HalwaShare is brought up, and its
     page collects it. The page always asks before anything is sent. */

const ORIGIN = 'https://halwashare.onrender.com';
const MAX_IMAGE = 25 * 1024 * 1024;
const PENDING_TTL = 2 * 60 * 1000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'image', title: 'Send picture to HalwaShare', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'link', title: 'Send link to HalwaShare', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'selection', title: 'Send “%s” to HalwaShare', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'page', title: 'Send this page to HalwaShare', contexts: ['page'] });
  });
});

chrome.action.onClicked.addListener(() => { openHalwa(false); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Asking for access to the picture's site must happen right away, while
  // the click still counts as the person's own action.
  let access = Promise.resolve(false);
  if (info.menuItemId === 'image' && info.srcUrl && /^https?:/.test(info.srcUrl)) {
    let origin = null;
    try { origin = new URL(info.srcUrl).origin + '/*'; } catch (_) {}
    if (origin) access = chrome.permissions.request({ origins: [origin] }).catch(() => false);
  }
  handleClick(info, tab, access);
});

async function handleClick(info, tab, access) {
  let item = null;
  if (info.menuItemId === 'image' && info.srcUrl) {
    item = await imageItem(info.srcUrl, await access);
  } else if (info.menuItemId === 'link' && info.linkUrl) {
    item = { text: info.linkUrl };
  } else if (info.menuItemId === 'selection' && info.selectionText) {
    item = { text: info.selectionText };
  } else if (info.menuItemId === 'page') {
    const url = info.pageUrl || (tab && tab.url) || '';
    item = { text: (tab && tab.title ? tab.title + '\n' : '') + url };
  }
  if (!item) return;
  await chrome.storage.session.set({ pending: { item, at: Date.now() } });
  openHalwa(true);
}

async function imageItem(src, allowed) {
  try {
    if (!src.startsWith('data:') && !allowed) throw new Error('no access');
    const res = await fetch(src);
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    if (!blob.size || blob.size > MAX_IMAGE) throw new Error('too big');
    const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
    const ext = (type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').replace('jpeg', 'jpg') || 'png';
    let name = 'picture.' + ext;
    try {
      const last = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
      if (/^[^\/:*?"<>|]{1,80}\.[a-z0-9]{2,5}$/i.test(last)) name = last;
    } catch (_) {}
    return { file: { name, type, data: await toBase64(blob) } };
  } catch (_) {
    // Could not fetch it: send where it lives instead.
    return src.startsWith('data:') ? null : { text: src };
  }
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* A room tab if there is one, then any HalwaShare tab, else a new one. */
async function openHalwa(deliver) {
  const tabs = (await chrome.tabs.query({ url: ORIGIN + '/*' }))
    .filter(t => { try { return /^\/(join\/\d{6})?$/.test(new URL(t.url).pathname); } catch (_) { return false; } });
  const target = tabs.find(t => /\/join\/\d{6}/.test(t.url || '')) || tabs[0];
  if (!target) {
    await chrome.tabs.create({ url: ORIGIN + '/' });
    return; // its page collects the item once it loads
  }
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });
  if (deliver) chrome.tabs.sendMessage(target.id, { type: 'halwa-deliver' }).catch(() => {});
}

/* The HalwaShare page asks for what is waiting; it is handed over once. */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== 'halwa-take') return;
  let fromHalwa = false;
  try { fromHalwa = new URL(sender.url || (sender.tab && sender.tab.url) || '').origin === ORIGIN; } catch (_) {}
  if (!fromHalwa) { reply(null); return; }
  chrome.storage.session.get('pending').then(({ pending }) => {
    if (!pending || Date.now() - pending.at > PENDING_TTL) { reply(null); return; }
    chrome.storage.session.remove('pending').then(() => reply({ item: pending.item }));
  });
  return true; // answering asynchronously
});
