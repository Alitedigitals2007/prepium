try { require('dotenv').config(); } catch (_) {}

const KEYS = [
  process.env.GEMINI_API_KEY_PRIMARY,
  process.env.GEMINI_API_KEY_SECONDARY
].filter(Boolean);

if (KEYS.length < 2) {
  console.warn('[KeyRotator] Only one Gemini key found - load balancing disabled');
}

let currentIndex = 0;
let consecutiveFails = 0;

function getNextKey() {
  const key = KEYS[currentIndex % KEYS.length];
  currentIndex++;
  return key;
}

function rewriteUrl(urlStr) {
  if (!urlStr.includes('generativelanguage.googleapis.com')) return null;
  const newKey = getNextKey();
  const newUrl = urlStr.replace(/key=[^&]+/, `key=${encodeURIComponent(newKey)}`);
  const keyUsed = newKey === process.env.GEMINI_API_KEY_PRIMARY ? 'PRIMARY' : 'SECONDARY';
  console.log(`[KeyRotator] ${keyUsed} → ${urlStr.slice(0, 60)}...`);
  return newUrl;
}

const originalFetch = globalThis.fetch;

globalThis.fetch = async function patchedFetch(input, init) {
  const url = typeof input === 'string' ? input
    : input && typeof input === 'object' && input.url ? input.url
    : null;

  if (url && url.includes('generativelanguage.googleapis.com')) {
    const rewritten = rewriteUrl(url);
    if (rewritten) {
      const newInput = typeof input === 'string' ? rewritten
        : new Request(rewritten, input);
      try {
        const res = await originalFetch.call(globalThis, newInput, init);
        if (res.status === 429 && KEYS.length > 1) {
          console.log('[KeyRotator] Rate limited (429) - retrying with next key');
          const retryKey = getNextKey();
          const retryUrl = url.replace(/key=[^&]+/, `key=${encodeURIComponent(retryKey)}`);
          const retryInput = typeof input === 'string' ? retryUrl
            : new Request(retryUrl, input);
          return originalFetch.call(globalThis, retryInput, init);
        }
        if (!res.ok) consecutiveFails++;
        else consecutiveFails = 0;
        return res;
      } catch (err) {
        consecutiveFails++;
        if (KEYS.length > 1 && consecutiveFails < KEYS.length * 2) {
          console.log(`[KeyRotator] Error (${err.message}) - retrying with next key`);
          const failKey = getNextKey();
          const failUrl = url.replace(/key=[^&]+/, `key=${encodeURIComponent(failKey)}`);
          const failInput = typeof input === 'string' ? failUrl
            : new Request(failUrl, input);
          return originalFetch.call(globalThis, failInput, init);
        }
        throw err;
      }
    }
  }

  return originalFetch.call(globalThis, input, init);
};

console.log(`[KeyRotator] Active with ${KEYS.length} Gemini keys (round-robin + auto-failover)`);
