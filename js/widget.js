(() => {
  "use strict";

  const KEY = "pogeun-routine-v1";
  const TZ = "Asia/Seoul";
  const kind = new URLSearchParams(location.search).get("k") || "today";
  const standalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "null") || {};
    } catch {
      return {};
    }
  }

  function kstParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "long",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      time: `${get("hour")}:${get("minute")}`,
      weekday: get("weekday"),
      month: Number(get("month")),
      day: Number(get("day")),
    };
  }

  function dur(ms) {
    if (!ms || ms < 0) return "—";
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h <= 0) return `${m}분`;
    if (m === 0) return `${h}시간`;
    return `${h}시간 ${m}분`;
  }

  function sleepMs(entry) {
    let ms = new Date(entry.wakeAt) - new Date(entry.bedAt);
    if (ms <= 0) ms += 86400000;
    return ms;
  }

  function snapshot() {
    const state = load();
    const today = kstParts().date;
    const sleeps = Array.isArray(state.sleeps) ? state.sleeps : [];
    const todos = Array.isArray(state.todos) ? state.todos : [];
    const hearts = Array.isArray(state.hearts) ? state.hearts : [];
    const last = [...sleeps].sort((a, b) => new Date(b.wakeAt) - new Date(a.wakeAt))[0];
    const rec = (Number(state.profile?.recommendedSleep) || 8) * 7 * 3600000;
    let week = 0;
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(`${today}T12:00:00+09:00`);
      day.setDate(day.getDate() - (6 - i));
      const key = kstParts(day).date;
      const found = sleeps
        .filter((item) => kstParts(new Date(item.wakeAt)).date === key)
        .sort((a, b) => new Date(b.wakeAt) - new Date(a.wakeAt))[0];
      if (found) week += sleepMs(found);
    }
    const done = todos.filter((item) => item.doneDate === today).length;
    const lastHeart = hearts[0];
    const todayHearts = hearts.filter((item) => kstParts(new Date(item.at)).date === today).length;
    return {
      sleepTitle: last ? dur(sleepMs(last)) : "수면 없음",
      sleepRange: last
        ? `${kstParts(new Date(last.bedAt)).time} → ${kstParts(new Date(last.wakeAt)).time}`
        : "기록을 남겨 보세요",
      weekTotal: dur(week),
      weekRecommended: dur(rec),
      todoLine: `${done}/${todos.length}`,
      heartTime: lastHeart ? kstParts(new Date(lastHeart.at)).time : "--:--",
      todayHearts,
    };
  }

  function card(title, value, sub) {
    return `<article class="w-card">
      <p>${title}</p>
      <strong>${value}</strong>
      <span>${sub}</span>
    </article>`;
  }

  function round(title, value) {
    return `<article class="w-round">
      <p>${title}</p>
      <strong>${value}</strong>
    </article>`;
  }

  function renderCards() {
    const snap = snapshot();
    const map = {
      today:
        card("어젯밤", snap.sleepTitle, snap.sleepRange) +
        card("할 일", snap.todoLine, "오늘 완료") +
        round("♥", snap.heartTime),
      heart: round("♥ 하트", snap.heartTime) + card("오늘", `${snap.todayHearts}번`, "하트를 누른 횟수"),
      sleep:
        card("최근 7일", snap.weekTotal, `권장 ${snap.weekRecommended}`) +
        card("어젯밤", snap.sleepTitle, snap.sleepRange),
    };
    document.getElementById("cards").innerHTML = map[kind] || map.today;
    document.querySelectorAll(".lock-kinds a").forEach((a) => {
      a.classList.toggle("on", a.getAttribute("href") === `?k=${kind}`);
    });
  }

  function tickClock() {
    const p = kstParts();
    document.getElementById("lock-clock").textContent = p.time;
    document.getElementById("lock-date").textContent = `${p.month}월 ${p.day}일 ${p.weekday}`;
  }

  document.documentElement.classList.toggle("standalone", standalone);
  if (standalone) {
    const hint = document.getElementById("hint");
    if (hint) hint.hidden = true;
  }

  tickClock();
  renderCards();
  setInterval(tickClock, 1000);
  setInterval(renderCards, 15000);
  window.addEventListener("storage", renderCards);
  window.addEventListener("pageshow", renderCards);
})();
