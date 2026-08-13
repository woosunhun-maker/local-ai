const state = { token: null, messages: [], busy: false };
const pairingView = document.querySelector("#pairing-view");
const chatView = document.querySelector("#chat-view");
const messagesView = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const prompt = document.querySelector("#prompt");
const send = document.querySelector("#send");
const connectionLabel = document.querySelector("#connection-label");
const statusDot = document.querySelector("#status-dot");

function tokenStore(mode, value) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("local-ai-secure-chat", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("credentials");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("credentials", mode === "read" ? "readonly" : "readwrite");
      const store = transaction.objectStore("credentials");
      const operation = mode === "read" ? store.get("device-token") : mode === "write" ? store.put(value, "device-token") : store.delete("device-token");
      operation.onsuccess = () => resolve(operation.result ?? null);
      operation.onerror = () => reject(operation.error);
      transaction.oncomplete = () => database.close();
    };
  });
}

function setConnected(connected, label) {
  statusDot.classList.toggle("connected", connected);
  connectionLabel.textContent = label;
}

function showPaired(paired) {
  pairingView.hidden = paired;
  chatView.hidden = !paired;
}

function addMessage(role, content) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const paragraph = document.createElement("p");
  paragraph.textContent = content;
  article.append(paragraph);
  messagesView.append(article);
  messagesView.scrollTop = messagesView.scrollHeight;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) throw Object.assign(new Error("request_failed"), { status: response.status });
  return response;
}

async function pairFromFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  const secret = params.get("pair");
  if (!secret) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  const response = await api("/api/pair", {
    method: "POST",
    body: JSON.stringify({ secret, deviceName: "iPhone Local AI" }),
  });
  const result = await response.json();
  state.token = result.deviceToken;
  await tokenStore("write", state.token);
  return true;
}

async function checkStatus() {
  try {
    state.token = await tokenStore("read");
    if (!state.token) await pairFromFragment();
    if (!state.token) {
      showPaired(false);
      return setConnected(false, "페어링 필요");
    }
    const response = await api("/api/status");
    const status = await response.json();
    showPaired(true);
    setConnected(true, `${status.deviceName} · Mac 직접 연결`);
  } catch (error) {
    if (error.status === 401) {
      await tokenStore("delete");
      state.token = null;
      showPaired(false);
      return setConnected(false, "페어링 만료");
    }
    showPaired(Boolean(state.token));
    setConnected(false, "Mac 연결 안 됨");
  }
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (!text || state.busy) return;
  state.busy = true;
  prompt.value = "";
  send.disabled = true;
  state.messages.push({ role: "user", content: text });
  addMessage("user", text);
  setConnected(true, "생각 중…");
  try {
    const response = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages: state.messages, stream: false }),
    });
    const result = await response.json();
    const answer = result?.choices?.[0]?.message?.content ?? "응답을 읽지 못했습니다.";
    state.messages.push({ role: "assistant", content: answer });
    addMessage("assistant", answer);
    setConnected(true, "Mac 직접 연결");
  } catch {
    addMessage("system", "현재 로컬 AI에 연결할 수 없습니다. 잠시 후 다시 시도하세요.");
    setConnected(false, "응답 실패");
  } finally {
    state.busy = false;
    send.disabled = false;
    prompt.focus();
  }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
checkStatus();
