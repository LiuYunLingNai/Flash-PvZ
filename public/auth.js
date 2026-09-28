// 账号 / 云存档前端逻辑。
// 核心原理：Ruffle 把 Flash 存档(SharedObject)以 base64 存进浏览器 localStorage。
// 我们在开局前把该用户的存档写回 localStorage，游戏运行时就读到它；
// 游戏过程中定期把 localStorage 快照上传服务器，按账号分别保存。
(function () {
  const $ = (s) => document.querySelector(s);
  const overlay = $("#auth-overlay");
  const topbar = $("#topbar");
  const form = $("#auth-form");
  const msg = $("#auth-msg");
  const btnLogin = $("#btn-login");
  const btnRegister = $("#btn-register");

  let syncTimer = null;
  let lastPushed = "";            // 上次上传的快照，避免无变化时重复上传

  async function api(path, opts = {}) {
    const ctrl = new AbortController();
    // 8 秒还没响应就中止，避免服务器抽风时永远卡在“登录中…”
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      return await fetch(path, {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        ...opts,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- localStorage <-> 服务器 ----
  function snapshot() {
    const o = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      o[k] = localStorage.getItem(k);
    }
    return o;
  }
  function restore(data) {
    for (const k in data) {
      try { localStorage.setItem(k, data[k]); } catch (e) {}
    }
  }
  function setSync(t) { const el = $("#sync-status"); if (el) el.textContent = t; }

  async function pushSave(useBeacon) {
    const data = snapshot();
    const json = JSON.stringify(data);
    if (json === lastPushed) return;          // 没变化就不传
    const body = JSON.stringify({ data });
    if (useBeacon && navigator.sendBeacon) {
      const ok = navigator.sendBeacon("/api/save", new Blob([body], { type: "application/json" }));
      if (ok) lastPushed = json;
      return;
    }
    try {
      const r = await api("/api/save", { method: "PUT", body });
      if (r.ok) { lastPushed = json; setSync("已保存 " + new Date().toLocaleTimeString()); }
      else setSync("保存失败");
    } catch (e) { setSync("保存失败（网络）"); }
  }

  function startSync() {
    if (syncTimer) return;
    syncTimer = setInterval(() => pushSave(false), 15000);   // 每 15 秒
    document.addEventListener("visibilitychange", () => { if (document.hidden) pushSave(false); });
    window.addEventListener("pagehide", () => pushSave(true));
  }

  // ---- 进入游戏（登录成功或已有会话）----
  async function enterGame(username, isGuest) {
    overlay.hidden = true;
    topbar.hidden = false;
    $("#who").textContent = username;
    localStorage.clear();      // 换账号时先清本机残留存档，避免串号
    lastPushed = "";
    if (!isGuest) {
      try {
        const r = await api("/api/save");
        if (r.ok) { const j = await r.json(); restore(j.data || {}); }
      } catch (e) {}
      setSync("云存档已就绪");
      startSync();
    } else {
      setSync("游客模式：进度只存本机，不上传");
    }
    window.PvZ.start();
  }

  // ---- 登录 / 注册（两个按钮各自直接触发，不再有隐藏的模式切换）----
  const ERRORS = {
    bad_username: "用户名需 2-20 位（字母数字下划线或中文）",
    bad_password: "密码至少 6 位",
    username_taken: "该用户名已被占用，换一个吧",
    bad_credentials: "用户名或密码错误。第一次玩请点“注册新账号”",
    too_many_attempts: "尝试过于频繁，请稍后再试",
  };

  async function doAuth(kind) {
    const username = $("#u").value.trim();
    const password = $("#p").value;
    if (!username || !password) { msg.textContent = "请填写用户名和密码"; return; }
    btnLogin.disabled = btnRegister.disabled = true;
    msg.textContent = kind === "register" ? "注册中…" : "登录中…";
    try {
      const r = await api("/api/" + kind, { method: "POST", body: JSON.stringify({ username, password }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { await enterGame(j.username, false); return; }
      msg.textContent = ERRORS[j.error] || "操作失败，请重试";
    } catch (e) {
      msg.textContent = "网络错误，请重试";
    } finally {
      btnLogin.disabled = btnRegister.disabled = false;
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); doAuth("login"); });
  btnRegister.addEventListener("click", () => doAuth("register"));

  $("#guest").onclick = () => enterGame("游客（本地）", true);

  $("#logout").onclick = async () => {
    await pushSave(false);                 // 退出前最后保存一次
    try { await api("/api/logout", { method: "POST" }); } catch (e) {}
    localStorage.clear();
    location.reload();
  };

  // ---- 启动：有会话直接进，否则显示登录框 ----
  (async () => {
    try {
      const r = await api("/api/me");
      if (r.ok) { const j = await r.json(); await enterGame(j.username, false); return; }
    } catch (e) {}
    overlay.hidden = false;
    $("#u").focus();
  })();
})();
