(() => {
  "use strict";

  const KEY = "pogeun-routine-v1";
  const TZ = "Asia/Seoul";
  const MOODS = [
    { id: "calm", label: "평온", icon: "☁︎", color: "#A88AD9" },
    { id: "joy", label: "기쁨", icon: "✦", color: "#E0B25C" },
    { id: "tired", label: "피곤", icon: "◌", color: "#8AA3C7" },
    { id: "sad", label: "속상", icon: "☁", color: "#9A8792" },
    { id: "flutter", label: "설렘", icon: "♡", color: "#E88CA8" },
  ];
  const WEEK = "일월화수목금토";
  const TITLES = {
    today: ["TODAY, GENTLY", "소중한 나의 포근한 하루"],
    sleep: ["SLEEP RHYTHM", "내 수면 리듬"],
    diary: ["SOFT DIARY", "마음 기록장"],
    routine: ["LITTLE ROUTINES", "나를 챙기는 루틴"],
    stats: ["WEEKLY GLANCE", "이번 주의 나"],
    vault: ["SOFT VAULT", "사이트별 계정 금고"],
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]));
  }

  function now() {
    return new Date();
  }

  function kstParts(date = now()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    return {
      date: `${get("year")}-${get("month")}-${get("day")}`,
      time: `${get("hour")}:${get("minute")}`,
      weekday: get("weekday"),
    };
  }

  function todayKey(date = now()) {
    return kstParts(date).date;
  }

  function addDays(dateStr, days) {
    const base = new Date(`${dateStr}T12:00:00+09:00`);
    base.setDate(base.getDate() + days);
    return todayKey(base);
  }

  function lastDays(n = 7) {
    const end = todayKey();
    return Array.from({ length: n }, (_, i) => addDays(end, i - (n - 1)));
  }

  function weekdayKo(dateStr) {
    const day = new Date(`${dateStr}T12:00:00+09:00`).getDay();
    return WEEK[day];
  }

  function prettyDate(dateStr) {
    const [y, m, d] = dateStr.split("-");
    return `${Number(m)}월 ${Number(d)}일`;
  }

  function fmtTime(iso) {
    if (!iso) return "";
    return kstParts(new Date(iso)).time;
  }

  function fmtDateTime(iso) {
    const p = kstParts(new Date(iso));
    return `${prettyDate(p.date)} · ${p.time}`;
  }

  function fmtDur(ms) {
    if (!ms || ms < 0) return "—";
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h <= 0) return `${m}분`;
    if (m === 0) return `${h}시간`;
    return `${h}시간 ${m}분`;
  }

  function sleepMs(entry) {
    const bed = new Date(entry.bedAt).getTime();
    const wake = new Date(entry.wakeAt).getTime();
    let ms = wake - bed;
    if (ms <= 0) ms += 86400000;
    return ms;
  }

  function wakeDate(entry) {
    return kstParts(new Date(entry.wakeAt)).date;
  }

  function combine(dateStr, hm) {
    return new Date(`${dateStr}T${hm}:00+09:00`).toISOString();
  }

  function blank() {
    return {
      profile: {
        name: "",
        eyedropHours: 4,
        recommendedSleep: 8,
        vaultPin: "",
      },
      sleeps: [],
      diaries: [],
      todos: [
        { id: uid(), title: "물 마시기" },
        { id: uid(), title: "가벼운 스트레칭" },
      ],
      eyedrops: [],
      hearts: [],
      accounts: [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const data = { ...blank(), ...JSON.parse(raw) };
      data.profile = { ...blank().profile, ...(data.profile || {}) };
      data.todos = Array.isArray(data.todos) && data.todos.length ? data.todos : blank().todos;
      return data;
    } catch {
      return blank();
    }
  }

  function save() {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  let state = load();
  let tab = sessionStorage.getItem("pogeun-tab") || "today";
  let vaultUnlocked = !state.profile.vaultPin;
  let toastTimer = 0;
  let selectedMood = "calm";

  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  document.documentElement.classList.toggle("standalone", isStandalone);

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.hidden = false;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), 1700);
  }

  function sleepForDay(dateStr) {
    const found = state.sleeps
      .filter((item) => wakeDate(item) === dateStr)
      .sort((a, b) => new Date(b.wakeAt) - new Date(a.wakeAt));
    return found[0] || null;
  }

  function lastSleep() {
    return [...state.sleeps].sort((a, b) => new Date(b.wakeAt) - new Date(a.wakeAt))[0] || null;
  }

  function weekSleep() {
    const days = lastDays(7);
    const recH = Number(state.profile.recommendedSleep) || 8;
    const items = days.map((date) => {
      const entry = sleepForDay(date);
      return { date, entry, ms: entry ? sleepMs(entry) : 0 };
    });
    const recorded = items.filter((d) => d.entry);
    const total = items.reduce((sum, d) => sum + d.ms, 0);
    const avg = recorded.length ? total / recorded.length : 0;
    return {
      days: items,
      total,
      avg,
      recorded: recorded.length,
      recommendedDay: recH * 3600000,
      recommendedWeek: recH * 7 * 3600000,
    };
  }

  function lastEyedrop() {
    return [...state.eyedrops].sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;
  }

  function nextEyedrop() {
    const last = lastEyedrop();
    if (!last) return null;
    const hours = Number(state.profile.eyedropHours) || 4;
    return new Date(new Date(last.at).getTime() + hours * 3600000);
  }

  function todayTodos() {
    const today = todayKey();
    const done = state.todos.filter((t) => t.doneDate === today).length;
    return { items: state.todos, done, total: state.todos.length };
  }

  function todayDiary() {
    return state.diaries.find((d) => d.date === todayKey()) || null;
  }

  function moodById(id) {
    return MOODS.find((m) => m.id === id) || MOODS[0];
  }

  function greeting() {
    const name = state.profile.name.trim();
    return name ? `${name}의 포근한 하루` : "소중한 나의 포근한 하루";
  }

  function closeSheet() {
    const el = $("#sheet");
    el.classList.remove("on");
    setTimeout(() => {
      el.hidden = true;
      el.innerHTML = "";
    }, 260);
  }

  function openSheet(html) {
    const el = $("#sheet");
    el.hidden = false;
    el.innerHTML = `<button class="back" type="button" data-act="close-sheet" aria-label="닫기"></button>
      <div class="panel"><div class="sheet-handle"></div>${html}</div>`;
    requestAnimationFrame(() => el.classList.add("on"));
  }

  function installBanner() {
    if (isStandalone) return "";
    return `<section class="card hint install-card">
      <p class="card-kicker">이 아이폰에 앱으로 담기</p>
      <p class="card-title" style="font-size:20px">홈 화면에 추가하면 끝이에요</p>
      <p class="card-sub">아래 화면은 사파리가 아니라, 이 폰만의 기록이 됩니다. 만든 사람 맥은 필요 없어요.</p>
      <ol class="install-steps">
        <li>하단 <b>공유</b> 버튼을 눌러요</li>
        <li><b>홈 화면에 추가</b>를 고르고 추가를 눌러요</li>
        <li>홈 화면의 <b>포근루틴</b>을 눌러 앱처럼 써요</li>
        <li>설정에서 <b>오늘·하트·수면 위젯</b>도 홈 화면에 담을 수 있어요</li>
      </ol>
    </section>`;
  }

  function renderToday() {
    const sleep = lastSleep();
    const week = weekSleep();
    const todos = todayTodos();
    const drop = lastEyedrop();
    const next = nextEyedrop();
    const diary = todayDiary();
    const todayHearts = state.hearts.filter((h) => kstParts(new Date(h.at)).date === todayKey());
    const lastHeart = state.hearts[0];
    TITLES.today[1] = greeting();

    const sleepCard = sleep
      ? `<p class="card-kicker">☾ 어젯밤의 휴식</p>
         <p class="card-title">${esc(fmtDur(sleepMs(sleep)))}</p>
         <p class="card-sub">${esc(fmtTime(sleep.bedAt))} → ${esc(fmtTime(sleep.wakeAt))}</p>`
      : `<p class="card-kicker">☾ 어젯밤의 휴식</p>
         <p class="card-title">아직 기록이 없어요</p>
         <p class="card-sub">취침과 기상 시간을 남겨 보세요.</p>`;

    return `${installBanner()}
      <div class="stack">
        <section class="card sleep">
          ${sleepCard}
          <p class="tiny" style="margin-top:10px">최근 7일 총 ${esc(fmtDur(week.total))} · 권장 ${esc(fmtDur(week.recommendedWeek))}</p>
          <button class="btn pink block" type="button" data-act="open-sleep">수면 기록하기</button>
        </section>
        <section class="card heart">
          <p class="card-kicker">♡ 지금 이 순간</p>
          <button class="heart-btn" type="button" data-act="heart" aria-label="하트 누르고 시간 기록">♥</button>
          <p class="card-sub">하트를 누르면 지금 시간이 남아요.</p>
          <p class="tiny">오늘 ${todayHearts.length}번${lastHeart ? ` · 마지막 ${esc(fmtTime(lastHeart.at))}` : ""}</p>
        </section>
        <section class="card">
          <div class="row">
            <p class="card-kicker" style="margin:0">오늘의 작은 체크</p>
            <span class="tiny">${todos.done}/${todos.total}</span>
          </div>
          ${todoList(todos.items, false)}
          <button class="btn ghost block" type="button" data-tab="routine">루틴 관리하기</button>
        </section>
        <section class="card drop">
          <div class="row">
            <div>
              <p class="card-kicker">💧 다음 안약 예정</p>
              <p class="card-title" style="font-size:18px">${next ? esc(fmtDateTime(next.toISOString())) : "아직 없어요"}</p>
              <p class="tiny">${drop ? `최근 ${esc(fmtTime(drop.at))}` : "간격은 설정에서 바꿀 수 있어요"}</p>
            </div>
            <button class="btn mint small" type="button" data-act="eyedrop">넣었어요</button>
          </div>
        </section>
        <button class="card link-row" type="button" data-act="open-diary">
          <div>
            <p class="card-kicker">✎ 오늘 마음은 어때요?</p>
            <p class="card-sub">${diary ? esc(diary.text || moodById(diary.mood).label) : "한 줄이면 충분해요."}</p>
          </div>
          <span class="muted">›</span>
        </button>
        <button class="card link-row" type="button" data-act="open-vault">
          <div>
            <p class="card-kicker">🔐 계정 금고</p>
            <p class="card-sub">${state.accounts.length ? `${state.accounts.length}개 사이트` : "이메일·비밀번호를 이 아이폰에만 저장"}</p>
          </div>
          <span class="muted">›</span>
        </button>
      </div>`;
  }

  function todoList(items, manage) {
    if (!items.length) return `<p class="empty">할 일을 추가해 보세요.</p>`;
    const today = todayKey();
    return `<div class="check-list">${items
      .map((item) => {
        const done = item.doneDate === today;
        return `<div class="check-item ${done ? "done" : ""}">
          <button class="dot" type="button" data-act="toggle-todo" data-id="${item.id}" aria-label="완료">${done ? "✓" : ""}</button>
          <button class="label" type="button" data-act="toggle-todo" data-id="${item.id}">${esc(item.title)}</button>
          ${manage ? `<button class="x" type="button" data-act="del-todo" data-id="${item.id}" aria-label="삭제">×</button>` : ""}
        </div>`;
      })
      .join("")}</div>`;
  }

  function renderBars(week) {
    const max = Math.max(week.recommendedDay, ...week.days.map((d) => d.ms), 1);
    return `<div class="bars">${week.days
      .map((d) => {
        const pct = d.ms ? Math.max(10, Math.round((d.ms / max) * 100)) : 8;
        return `<div class="bar-col">
          <div class="bar-track"><div class="bar-fill ${d.ms ? "" : "empty"}" style="height:${pct}%"></div></div>
          <span>${weekdayKo(d.date)}</span>
        </div>`;
      })
      .join("")}</div>`;
  }

  function renderSleep() {
    const week = weekSleep();
    const list = [...state.sleeps].sort((a, b) => new Date(b.wakeAt) - new Date(a.wakeAt));
    return `<div class="stack">
      <section class="card sleep">
        <div class="row">
          <p class="card-kicker" style="margin:0">최근 7일 평균</p>
          <span>☾</span>
        </div>
        <p class="card-title">${week.recorded ? esc(fmtDur(week.avg)) : "기록이 없어요"}</p>
        <div class="stat-grid" style="margin-top:14px">
          <div class="stat"><p>7일 총 수면</p><strong>${esc(fmtDur(week.total))}</strong></div>
          <div class="stat pink"><p>7일 권장</p><strong>${esc(fmtDur(week.recommendedWeek))}</strong></div>
          <div class="stat mint"><p>하루 권장</p><strong>${esc(state.profile.recommendedSleep)}시간</strong></div>
          <div class="stat"><p>기록한 날</p><strong>${week.recorded}/7일</strong></div>
        </div>
      </section>
      <section class="card">
        <p class="card-kicker">이번 주 흐름</p>
        ${renderBars(week)}
      </section>
      <section class="card">
        <div class="section-head">
          <h2>수면 기록</h2>
          <button class="btn pink small" type="button" data-act="open-sleep">＋</button>
        </div>
        ${
          list.length
            ? list
                .map(
                  (item) => `<button class="entry" type="button" data-act="open-sleep" data-id="${item.id}">
                    <b>🛏 ${esc(prettyDate(wakeDate(item)))} · ${esc(fmtTime(item.bedAt))} → ${esc(fmtTime(item.wakeAt))}</b>
                    <span class="tiny">${esc(fmtDur(sleepMs(item)))}${item.memo ? ` · ${esc(item.memo)}` : ""}</span>
                  </button>`
                )
                .join("")
            : `<p class="empty">취침·기상 시간을 남기면 막대와 총량이 채워져요.</p>`
        }
      </section>
    </div>`;
  }

  function renderDiary() {
    const list = [...state.diaries].sort((a, b) => (a.date < b.date ? 1 : -1));
    const today = todayDiary();
    return `<div class="stack">
      <button class="card link-row" type="button" data-act="open-diary">
        <div>
          <p class="card-kicker">✎ 오늘 어떤 마음이었나요?</p>
          <p class="card-sub">${today ? esc(today.text || "오늘은 이미 한 줄을 남겼어요.") : "한 줄이면 충분해요."}</p>
        </div>
        <span class="muted">›</span>
      </button>
      <section class="card">
        <p class="card-kicker">지난 기록</p>
        ${
          list.length
            ? list
                .map((item) => {
                  const mood = moodById(item.mood);
                  return `<button class="entry" type="button" data-act="open-diary" data-id="${item.id}">
                    <b>${mood.icon} ${esc(mood.label)} · ${esc(prettyDate(item.date))}</b>
                    <span class="tiny">${esc(item.text || "한 줄 없이 마음만 남겼어요.")}</span>
                  </button>`;
                })
                .join("")
            : `<p class="empty">감정 칩을 고르고 한 줄을 남겨 보세요.</p>`
        }
      </section>
    </div>`;
  }

  function renderRoutine() {
    const todos = todayTodos();
    const next = nextEyedrop();
    const drop = lastEyedrop();
    return `<div class="stack">
      <section class="card drop">
        <div class="row">
          <div>
            <p class="card-kicker">💧 다음 안약 예정</p>
            <p class="card-title" style="font-size:18px">${next ? esc(fmtDateTime(next.toISOString())) : "아직 없어요"}</p>
            <p class="tiny">${drop ? `최근 ${esc(fmtDateTime(drop.at))}` : "넣으면 다음 시각이 계산돼요"}</p>
          </div>
          <button class="btn mint small" type="button" data-act="eyedrop">넣었어요</button>
        </div>
      </section>
      <section class="card">
        <div class="row">
          <p class="card-kicker" style="margin:0">생활 체크리스트</p>
          <span class="tiny">${todos.done}/${todos.total}</span>
        </div>
        <button class="btn ghost block" type="button" data-act="open-todo">오늘의 작은 할 일 ＋</button>
        ${todoList(todos.items, true)}
      </section>
    </div>`;
  }

  function renderStats() {
    const week = weekSleep();
    const days = lastDays(7);
    const moods = days.map((date) => {
      const item = state.diaries
        .filter((d) => d.date === date)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      return { date, item };
    });
    const counts = {};
    moods.forEach((m) => {
      if (m.item) counts[m.item.mood] = (counts[m.item.mood] || 0) + 1;
    });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const topMood = top ? moodById(top[0]) : null;
    const gap = week.recommendedWeek - week.total;
    const heartWeek = state.hearts.filter((h) => lastDays(7).includes(kstParts(new Date(h.at)).date));
    let sleepNote = "기록이 쌓이면 한 주의 리듬이 보여요.";
    if (week.recorded) {
      if (gap > 30 * 60000) sleepNote = "이번 주는 권장보다 조금 짧아요. 오늘 밤은 더 포근해도 좋아요.";
      else if (gap < -30 * 60000) sleepNote = "이번 주는 권장보다 충분히 쉬었어요. 이 리듬을 지켜 보세요.";
      else sleepNote = "이번 주 수면은 권장 리듬에 가까워요.";
    }
    return `<div class="stack">
      <section class="card sleep">
        <div class="row">
          <p class="card-kicker" style="margin:0">최근 7일 평균</p>
          <span>☾</span>
        </div>
        <p class="card-title">${week.recorded ? esc(fmtDur(week.avg)) : "아직 없어요"}</p>
        <div class="stat-grid" style="margin-top:14px">
          <div class="stat"><p>총 수면</p><strong>${esc(fmtDur(week.total))}</strong></div>
          <div class="stat pink"><p>권장 수면</p><strong>${esc(fmtDur(week.recommendedWeek))}</strong></div>
        </div>
      </section>
      <section class="card">
        <p class="card-kicker">수면 시간</p>
        ${renderBars(week)}
      </section>
      <section class="card">
        <div class="row">
          <p class="card-kicker" style="margin:0">감정 변화</p>
          <span class="tiny">${topMood ? `주로 ${topMood.label}` : "기록 없음"}</span>
        </div>
        <div class="mood-line">${moods
          .map((m) => `<div class="mood-dot">${m.item ? moodById(m.item.mood).icon : "·"}<span>${weekdayKo(m.date)}</span></div>`)
          .join("")}</div>
      </section>
      <section class="card">
        <p class="card-kicker">♡ 하트 기록</p>
        <p class="card-title" style="font-size:20px">최근 7일 ${heartWeek.length}번</p>
        <button class="btn ghost block" type="button" data-act="open-hearts">시간 목록 보기</button>
      </section>
      <section class="card hint">
        <p class="card-kicker">♥ 오늘의 한 줄</p>
        <p class="card-sub">${topMood ? `이번 주에는 ‘${topMood.label}’의 순간이 가장 많아요.` : sleepNote}</p>
        <p class="tiny" style="margin-top:8px">${esc(sleepNote)}</p>
      </section>
    </div>`;
  }

  function renderVault() {
    if (state.profile.vaultPin && !vaultUnlocked) {
      return `<div class="stack">
        <section class="card">
          <p class="card-kicker">🔐 계정 금고</p>
          <p class="card-title">잠겨 있어요</p>
          <p class="card-sub">설정한 숫자 비밀번호를 입력하세요.</p>
          <div class="field" style="margin-top:14px">
            <span>비밀번호</span>
            <input id="vault-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off" />
          </div>
          <button class="btn pink block" type="button" data-act="unlock-vault">열기</button>
        </section>
      </div>`;
    }
    const list = [...state.accounts].sort((a, b) => a.site.localeCompare(b.site, "ko"));
    return `<div class="stack">
      <section class="card">
        <p class="card-kicker">이 아이폰에만 저장</p>
        <p class="card-sub">클라우드로 보내지 않아요. 사이트별로 이메일과 비밀번호를 한 번에 복사할 수 있어요.</p>
        <button class="btn pink block" type="button" data-act="open-account">사이트 추가</button>
      </section>
      ${
        list.length
          ? list
              .map(
                (item) => `<section class="card vault-card">
                  <div class="row">
                    <div>
                      <div class="vault-name">${esc(item.site)}</div>
                      <div class="vault-mail">${esc(item.email || "이메일 없음")}</div>
                    </div>
                    <button class="btn ghost small" type="button" data-act="open-account" data-id="${item.id}">수정</button>
                  </div>
                  <div class="copy-row">
                    <button class="btn ghost" type="button" data-act="copy" data-kind="email" data-id="${item.id}">이메일 복사</button>
                    <button class="btn pink" type="button" data-act="copy" data-kind="password" data-id="${item.id}">비밀번호 복사</button>
                  </div>
                </section>`
              )
              .join("")
          : `<p class="empty">자주 쓰는 사이트부터 하나 넣어 보세요.</p>`
      }
    </div>`;
  }

  function render() {
    const screen = $("#screen");
    const map = {
      today: renderToday,
      sleep: renderSleep,
      diary: renderDiary,
      routine: renderRoutine,
      stats: renderStats,
      vault: renderVault,
    };
    const pair = TITLES[tab] || TITLES.today;
    $("#eyebrow").textContent = pair[0];
    $("#headline").textContent = tab === "today" ? greeting() : pair[1];
    screen.innerHTML = (map[tab] || renderToday)();
    $$(".tabbar button").forEach((btn) => btn.classList.toggle("on", btn.dataset.tab === tab));
    sessionStorage.setItem("pogeun-tab", tab === "vault" ? "today" : tab);
  }

  function sleepSheet(id) {
    const item = state.sleeps.find((s) => s.id === id);
    const today = todayKey();
    const wakeP = item ? kstParts(new Date(item.wakeAt)) : { date: today, time: "07:15" };
    const bedP = item ? kstParts(new Date(item.bedAt)) : { date: today, time: "23:30" };
    openSheet(`<p class="eyebrow">SLEEP</p>
      <h1 style="margin-bottom:14px">${item ? "수면 수정" : "수면 기록하기"}</h1>
      <div class="field"><span>기상 날짜</span><input id="s-date" type="date" value="${esc(wakeP.date)}" /></div>
      <div class="field"><span>취침</span><input id="s-bed" type="time" value="${esc(bedP.time)}" /></div>
      <div class="field"><span>기상</span><input id="s-wake" type="time" value="${esc(wakeP.time)}" /></div>
      <div class="field"><span>메모</span><input id="s-memo" type="text" maxlength="80" value="${esc(item?.memo || "")}" placeholder="잘 잔 느낌, 깨운 횟수…" /></div>
      <button class="btn pink block" type="button" data-act="save-sleep" data-id="${item?.id || ""}">저장하기</button>
      ${item ? `<button class="btn ghost block" type="button" data-act="del-sleep" data-id="${item.id}">삭제</button>` : ""}`);
  }

  function diarySheet(id) {
    const item = state.diaries.find((d) => d.id === id) || todayDiary();
    selectedMood = item?.mood || "calm";
    openSheet(`<p class="eyebrow">DIARY</p>
      <h1 style="margin-bottom:8px">${item ? "마음 고치기" : "오늘 마음 남기기"}</h1>
      <div class="chips">${MOODS.map(
        (m) => `<button type="button" class="chip ${m.id === selectedMood ? "on" : ""}" data-act="mood" data-id="${m.id}">${m.icon} ${m.label}</button>`
      ).join("")}</div>
      <div class="field"><span>한 줄</span><textarea id="d-text" placeholder="오늘은 천천히 쉬어 가도 괜찮았다.">${esc(item?.text || "")}</textarea></div>
      <button class="btn pink block" type="button" data-act="save-diary" data-id="${item?.id || ""}">저장하기</button>
      ${item ? `<button class="btn ghost block" type="button" data-act="del-diary" data-id="${item.id}">삭제</button>` : ""}`);
  }

  function todoSheet() {
    openSheet(`<p class="eyebrow">ROUTINE</p>
      <h1 style="margin-bottom:14px">할 일 추가</h1>
      <div class="field"><span>내용</span><input id="t-title" type="text" maxlength="40" placeholder="물 마시기" /></div>
      <button class="btn pink block" type="button" data-act="save-todo">추가하기</button>`);
    setTimeout(() => $("#t-title")?.focus(), 80);
  }

  function accountSheet(id) {
    const item = state.accounts.find((a) => a.id === id);
    openSheet(`<p class="eyebrow">VAULT</p>
      <h1 style="margin-bottom:14px">${item ? "계정 수정" : "사이트 계정 저장"}</h1>
      <div class="field"><span>사이트</span><input id="a-site" type="text" value="${esc(item?.site || "")}" placeholder="네이버, 구글…" /></div>
      <div class="field"><span>이메일</span><input id="a-email" type="email" value="${esc(item?.email || "")}" placeholder="name@example.com" autocomplete="off" /></div>
      <div class="field"><span>비밀번호</span>
        <div class="pw-wrap">
          <input id="a-pass" type="password" value="${esc(item?.password || "")}" autocomplete="off" />
          <button class="btn ghost small" type="button" data-act="toggle-pass">보기</button>
        </div>
      </div>
      <div class="field"><span>메모</span><input id="a-note" type="text" value="${esc(item?.note || "")}" placeholder="아이디가 다르면 여기" /></div>
      <button class="btn pink block" type="button" data-act="save-account" data-id="${item?.id || ""}">저장하기</button>
      ${item ? `<button class="btn ghost block" type="button" data-act="del-account" data-id="${item.id}">삭제</button>` : ""}`);
  }

  function settingsSheet() {
    openSheet(`<p class="eyebrow">SETTINGS</p>
      <h1 style="margin-bottom:14px">표시와 리듬</h1>
      <div class="field"><span>표시 이름</span><input id="p-name" type="text" maxlength="12" value="${esc(state.profile.name)}" placeholder="예: 훈" /></div>
      <div class="field"><span>하루 권장 수면(시간)</span>
        <select id="p-sleep">${[6, 7, 7.5, 8, 8.5, 9]
          .map((n) => `<option value="${n}" ${Number(state.profile.recommendedSleep) === n ? "selected" : ""}>${n}시간</option>`)
          .join("")}</select>
      </div>
      <div class="field"><span>안약 간격(시간)</span>
        <select id="p-drop">${[1, 2, 3, 4, 6, 8, 12]
          .map((n) => `<option value="${n}" ${Number(state.profile.eyedropHours) === n ? "selected" : ""}>${n}시간</option>`)
          .join("")}</select>
      </div>
      <div class="field"><span>금고 숫자 비밀번호(선택)</span>
        <input id="p-pin" type="password" inputmode="numeric" maxlength="8" value="${esc(state.profile.vaultPin)}" placeholder="비워 두면 잠금 없음" />
      </div>
      <p class="card-kicker" style="margin-top:8px">홈·잠금화면 위젯</p>
      <p class="tiny">잠금화면처럼 보이는 위젯 카드를 홈 화면에 각각 담을 수 있어요. 기록은 이 아이폰의 포근루틴과 같습니다.</p>
      <a class="btn pink block" href="widget.html?k=today">오늘 위젯 담기</a>
      <a class="btn ghost block" href="widget.html?k=heart">하트 위젯 담기</a>
      <a class="btn ghost block" href="widget.html?k=sleep">수면 위젯 담기</a>
      <button class="btn pink block" type="button" data-act="save-settings">설정 저장하기</button>`);
  }

  function heartsSheet() {
    const list = [...state.hearts];
    openSheet(`<p class="eyebrow">HEARTS</p>
      <h1 style="margin-bottom:14px">하트를 누른 시간</h1>
      ${
        list.length
          ? list
              .map(
                (item) => `<div class="entry">
                  <b>♥ ${esc(fmtDateTime(item.at))}</b>
                  <button class="tiny" type="button" data-act="del-heart" data-id="${item.id}">지우기</button>
                </div>`
              )
              .join("")
          : `<p class="empty">오늘 화면의 하트를 누르면 그 시각이 여기에 쌓여요.</p>`
      }`);
  }

  async function copyText(text, ok) {
    try {
      await navigator.clipboard.writeText(text);
      toast(ok);
    } catch {
      toast("복사를 허용해 주세요");
    }
  }

  function onClick(event) {
    const btn = event.target.closest("[data-act], [data-tab]");
    if (!btn) return;
    if (btn.dataset.tab) {
      tab = btn.dataset.tab;
      closeSheet();
      render();
      return;
    }
    const act = btn.dataset.act;
    const id = btn.dataset.id || "";
    if (act === "close-sheet") return closeSheet();
    if (act === "open-sleep") return sleepSheet(id);
    if (act === "open-diary") return diarySheet(id);
    if (act === "open-todo") return todoSheet();
    if (act === "open-account") return accountSheet(id);
    if (act === "open-settings") return settingsSheet();
    if (act === "open-vault") {
      tab = "vault";
      render();
      return;
    }
    if (act === "open-hearts") return heartsSheet();
    if (act === "mood") {
      selectedMood = btn.dataset.id;
      $$(".chip", $("#sheet")).forEach((el) => el.classList.toggle("on", el.dataset.id === selectedMood));
      return;
    }
    if (act === "toggle-pass") {
      const input = $("#a-pass");
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "보기" : "숨기기";
      return;
    }
    if (act === "heart") {
      state.hearts.unshift({ id: uid(), at: now().toISOString() });
      save();
      btn.classList.add("pulse");
      setTimeout(() => btn.classList.remove("pulse"), 450);
      toast(`${fmtTime(state.hearts[0].at)}에 남겼어요`);
      render();
      return;
    }
    if (act === "eyedrop") {
      state.eyedrops.unshift({ id: uid(), at: now().toISOString() });
      save();
      toast("안약 시간을 남겼어요");
      render();
      return;
    }
    if (act === "toggle-todo") {
      const item = state.todos.find((t) => t.id === id);
      if (!item) return;
      item.doneDate = item.doneDate === todayKey() ? "" : todayKey();
      save();
      render();
      return;
    }
    if (act === "del-todo") {
      state.todos = state.todos.filter((t) => t.id !== id);
      save();
      render();
      return;
    }
    if (act === "save-sleep") {
      const date = $("#s-date").value;
      const bedT = $("#s-bed").value;
      const wakeT = $("#s-wake").value;
      if (!date || !bedT || !wakeT) return toast("시간과 날짜를 채워 주세요");
      const bedDate = bedT > wakeT ? addDays(date, -1) : date;
      const entry = {
        id: id || uid(),
        bedAt: combine(bedDate, bedT),
        wakeAt: combine(date, wakeT),
        memo: $("#s-memo").value.trim(),
      };
      if (id) state.sleeps = state.sleeps.map((s) => (s.id === id ? entry : s));
      else state.sleeps.unshift(entry);
      save();
      closeSheet();
      toast("수면을 남겼어요");
      render();
      return;
    }
    if (act === "save-diary") {
      const text = $("#d-text").value.trim();
      const entry = {
        id: id || uid(),
        date: todayKey(),
        mood: selectedMood,
        text,
        createdAt: now().toISOString(),
      };
      if (id) {
        const prev = state.diaries.find((d) => d.id === id);
        entry.date = prev?.date || todayKey();
        state.diaries = state.diaries.map((d) => (d.id === id ? entry : d));
      } else {
        const existing = todayDiary();
        if (existing) {
          entry.id = existing.id;
          entry.date = existing.date;
          state.diaries = state.diaries.map((d) => (d.id === existing.id ? entry : d));
        } else state.diaries.unshift(entry);
      }
      save();
      closeSheet();
      toast("마음을 남겼어요");
      render();
      return;
    }
    if (act === "save-todo") {
      const title = $("#t-title").value.trim();
      if (!title) return toast("할 일을 적어 주세요");
      state.todos.push({ id: uid(), title });
      save();
      closeSheet();
      render();
      return;
    }
    if (act === "save-account") {
      const site = $("#a-site").value.trim();
      const email = $("#a-email").value.trim();
      const password = $("#a-pass").value;
      if (!site) return toast("사이트 이름을 적어 주세요");
      if (!email && !password) return toast("이메일이나 비밀번호를 넣어 주세요");
      const entry = {
        id: id || uid(),
        site,
        email,
        password,
        note: $("#a-note").value.trim(),
      };
      if (id) state.accounts = state.accounts.map((a) => (a.id === id ? entry : a));
      else state.accounts.unshift(entry);
      save();
      closeSheet();
      toast("금고에 넣었어요");
      tab = "vault";
      render();
      return;
    }
    if (act === "save-settings") {
      state.profile.name = $("#p-name").value.trim();
      state.profile.recommendedSleep = Number($("#p-sleep").value);
      state.profile.eyedropHours = Number($("#p-drop").value);
      state.profile.vaultPin = $("#p-pin").value.trim();
      vaultUnlocked = !state.profile.vaultPin;
      save();
      closeSheet();
      toast("설정을 저장했어요");
      render();
      return;
    }
    if (act === "unlock-vault") {
      const pin = $("#vault-pin")?.value || "";
      if (pin === state.profile.vaultPin) {
        vaultUnlocked = true;
        render();
      } else toast("비밀번호가 달라요");
      return;
    }
    if (act === "copy") {
      const item = state.accounts.find((a) => a.id === id);
      if (!item) return;
      const kind = btn.dataset.kind;
      const value = kind === "email" ? item.email : item.password;
      if (!value) return toast(kind === "email" ? "이메일이 없어요" : "비밀번호가 없어요");
      copyText(value, kind === "email" ? "이메일을 복사했어요" : "비밀번호를 복사했어요");
      return;
    }
    if (act === "del-sleep") {
      state.sleeps = state.sleeps.filter((s) => s.id !== id);
      save();
      closeSheet();
      render();
      return;
    }
    if (act === "del-diary") {
      state.diaries = state.diaries.filter((d) => d.id !== id);
      save();
      closeSheet();
      render();
      return;
    }
    if (act === "del-account") {
      state.accounts = state.accounts.filter((a) => a.id !== id);
      save();
      closeSheet();
      tab = "vault";
      render();
      return;
    }
    if (act === "del-heart") {
      state.hearts = state.hearts.filter((h) => h.id !== id);
      save();
      heartsSheet();
      return;
    }
  }

  document.addEventListener("click", onClick);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet();
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  render();
})();
