/* Runs on HalwaShare's own pages only. Collects what the extension is
   holding and posts it to the page, which shows it and asks before sending. */
function collect() {
  chrome.runtime.sendMessage({ type: 'halwa-take' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.item) return;
    window.postMessage({ source: 'halwa-ext', item: res.item }, location.origin);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'halwa-deliver') collect();
});

collect();
