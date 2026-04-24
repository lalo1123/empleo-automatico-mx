// Typed wrappers around chrome.runtime.sendMessage / onMessage.
// - sendMessage returns a Promise with the reply.
// - onMessage routes handler return values (or resolved promises) back via sendResponse.

/**
 * Send a message to the background service worker and await the reply.
 * Rejects on chrome.runtime.lastError with a JS Error.
 * @param {object} msg
 * @returns {Promise<any>}
 */
export function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (reply) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(reply);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Register a chrome.runtime.onMessage listener that supports async handlers.
 * Handler return value (or resolved Promise value) is sent as the reply.
 * Thrown errors are converted to {ok: false, error: <message>}.
 * @param {(msg: any, sender: any) => any | Promise<any>} handler
 */
export function onMessage(handler) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Call the handler. If it throws synchronously, catch below.
    let result;
    try {
      result = handler(msg, sender);
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
      return false;
    }

    // If the result is a Promise, keep the channel open and resolve asynchronously.
    if (result && typeof result.then === "function") {
      result.then(
        (value) => {
          try {
            sendResponse(value);
          } catch (_) {
            // port may have closed; nothing we can do
          }
        },
        (err) => {
          try {
            sendResponse({ ok: false, error: (err && err.message) || String(err) });
          } catch (_) {
            // ignore
          }
        }
      );
      return true; // keep message channel open
    }

    // Synchronous reply.
    sendResponse(result);
    return false;
  });
}
