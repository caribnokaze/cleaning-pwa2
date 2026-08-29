(() => {
  const nativeFetch = window.fetch.bind(window);
  let expiryTimer;

  function returnToLogin() {
    if (window.location.pathname !== "/login") {
      window.location.replace("/login?expired=1");
    }
  }

  function scheduleExpiry(expiresAt) {
    window.clearTimeout(expiryTimer);
    const delay = Math.max(0, Number(expiresAt) * 1000 - Date.now() + 500);
    expiryTimer = window.setTimeout(returnToLogin, delay);
  }

  async function checkSession() {
    try {
      const response = await nativeFetch("/api/session", { cache: "no-store" });
      if (response.status === 401) {
        returnToLogin();
        return;
      }
      if (response.ok) {
        const session = await response.json();
        scheduleExpiry(session.expiresAt);
      }
    } catch (error) {
      console.warn("セッション状態を確認できませんでした。", error);
    }
  }

  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const request = args[0];
    const requestUrl = new URL(
      request instanceof Request ? request.url : String(request),
      window.location.href,
    );
    if (requestUrl.origin === window.location.origin && response.status === 401) {
      returnToLogin();
    }
    return response;
  };

  window.addEventListener("pageshow", checkSession);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkSession();
  });
  window.setInterval(checkSession, 60 * 1000);
})();
