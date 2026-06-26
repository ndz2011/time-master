const App = (() => {
  let tasks = [];
  let activeBox = null;  // 当前活跃的时间盒
  let dayBoxes = [];     // 当日已关闭的时间盒（用于时间线视图）
  let settings = {
    notifyEnabled: false,
    soundEnabled: true,
    filter: 'all',
    dateFilter: localStorage.getItem('tm_date_filter') || 'all',
  };
  let connected = false;
  let retryTimer = null;
  let activeTab = localStorage.getItem('tm_active_tab') || 'tasks';  // 'tasks' | 'timeline'

  async function api(method, path, body = null) {
    try {
      const opts = { method, headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch('/api' + path, opts);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      connected = true;
      updateConn();
      return await res.json();  // null 或对象（成功）；undefined（错误，见 catch）
    } catch(e) {
      connected = false;
      updateConn();
      console.warn('API error:', method, path, e);
      scheduleRetry();
      return undefined;  // 用 undefined 表示错误，null 表示服务器合法返回的空
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; if (!connected) loadAll(); }, 3000);
  }

  function updateConn() {
    const badge = document.getElementById('connBadge');
    if (connected) {
      badge.textContent = '已连接';
      badge.classList.remove('off');
    } else {
      badge.textContent = '离线';
      badge.classList.add('off');
    }
  }

  async function loadAll() {
    const [t, b, s] = await Promise.all([
      api('GET', '/tasks'),
      api('GET', '/boxes/active'),
      api('GET', '/settings'),
    ]);
    if (t) tasks = t;
    if (b !== undefined) activeBox = b;  // null=无活跃盒（清空），对象=有活跃盒
    if (s) Object.assign(settings, s);
    await loadDayBoxes();
    render();
  }

  async function loadDayBoxes() {
    const today = new Date();
    const dateStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const r = await api('GET', '/boxes?date=' + dateStr);
    if (r) dayBoxes = r.filter(b => b.status === 'closed');
  }

  function fmtTime(secs) {
    if (secs < 0) secs = 0;
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtDuration(secs) {
    if (secs < 60) return Math.floor(secs) + 's';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return h + 'h' + m + 'm';
    return m + 'm';
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function jsEsc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  }

  function fmtDate(epoch) {
    if (!epoch) return '';
    const d = new Date(epoch * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function taskDateKey(t) {
    return fmtDate(t.created);
  }

  async function openBox(taskId, budgetSecs) {
    const r = await api('POST', '/boxes', { task_id: taskId, budget_secs: budgetSecs });
    if (r) {
      activeBox = r;
      render();
    }
  }

  async function closeBox() {
    if (!activeBox) return;
    const r = await api('PUT', '/boxes/' + activeBox.id + '/close');
    if (r !== undefined) {
      activeBox = null;
      await loadDayBoxes();
      render();
    }
  }

  async function extendBox(addSecs) {
    if (!activeBox) return;
    const r = await api('PUT', '/boxes/' + activeBox.id + '/extend', { add_secs: addSecs });
    if (r) {
      activeBox = r;
      reminderFiredStages = new Set();  // 延长后重置超时提醒阶段
      dismissReminder();
      render();
      toast('已延长 ' + fmtDuration(addSecs));
    }
  }

  async function pauseBox() {
    if (!activeBox) return;
    const r = await api('PUT', '/boxes/' + activeBox.id + '/pause');
    if (r) { activeBox = r; render(); }
  }

  async function resumeBox() {
    if (!activeBox) return;
    const r = await api('PUT', '/boxes/' + activeBox.id + '/resume');
    if (r) { activeBox = r; render(); }
  }

  async function toggleDone(id) {
    const r = await api('POST', '/tasks/' + id + '/toggle');
    if (r) {
      const idx = tasks.findIndex(t => t.id === id);
      if (idx >= 0) tasks[idx] = r;
      // 任务被标记为完成，且仍有活跃盒：询问是否停止计时
      if (r.done && r.hasActiveBox) {
        const t = tasks[idx];
        const cf = document.getElementById('switchConfirm');
        cf.innerHTML = `任务「${esc(t.name)}」已完成，是否停止当前时间盒？
          <button class="btn btn-ghost btn-sm" onclick="App.switchConfirmCancel()">继续计时</button>
          <button class="btn btn-primary btn-sm" onclick="App.confirmStopBox()">停止计时</button>`;
        cf.classList.remove('off');
      }
      render();
    }
  }

  async function deleteTask(id) {
    if (activeBox && activeBox.taskId === id) await closeBox();
    const r = await api('DELETE', '/tasks/' + id);
    if (r) {
      tasks = tasks.filter(t => t.id !== id);
      render();
    }
  }

  async function addTask(name, desc, priority, plannedSecs) {
    const t = await api('POST', '/tasks', { name, desc, priority, plannedSecs });
    if (t) {
      tasks.unshift(t);
      if (!activeBox) {
        const budget = plannedSecs || settings.defaultBudgetSecs || 1500;
        await openBox(t.id, budget);
      }
      toast('已添加: ' + name);
    }
  }

  async function setCurrent(id) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    if (activeBox && activeBox.taskId !== id) {
      await closeBox();
    }
    if (!activeBox || activeBox.taskId !== id) {
      await openBox(id, t.plannedSecs || settings.defaultBudgetSecs || 1500);
    }
  }

  async function switchTask(id, name) {
    if (activeBox && activeBox.taskId === id) return;
    // 无活跃盒：直接切换，无需确认
    if (!activeBox) {
      await setCurrent(id);
      return;
    }
    // 有活跃盒：显示带实际时长的确认
    const worked = activeBox.workedSecs;
    const curTask = tasks.find(t => t.id === activeBox.taskId);
    const curName = curTask ? curTask.name : '当前任务';
    const cf = document.getElementById('switchConfirm');
    cf.innerHTML = `停止「${esc(curName)}」（已用 ${fmtDuration(worked)}）并为「${esc(name)}」开启新盒？
      <button class="btn btn-ghost btn-sm" onclick="App.switchConfirmCancel()">取消</button>
      <button class="btn btn-primary btn-sm" onclick="App.switchConfirmYes('${id}')">切换</button>`;
    cf.classList.remove('off');
  }

  function switchConfirmCancel() {
    document.getElementById('switchConfirm').classList.add('off');
  }

  async function switchConfirmYes(id) {
    switchConfirmCancel();
    await setCurrent(id);
  }

  function confirmStopBox() {
    switchConfirmCancel();
    closeBox();
  }

  // ── 快速开始计时（P1-2 + P1-4）：弹出预算预设 ──
  function quickStart(taskId) {
    const t = tasks.find(x => x.id === taskId);
    if (!t) return;
    const cf = document.getElementById('switchConfirm');
    const presets = [
      { secs: 1500, label: '25 分' },
      { secs: 2700, label: '45 分' },
      { secs: 3600, label: '60 分' },
    ];
    const planned = t.plannedSecs;
    const presetBtns = presets.map(p =>
      `<button class="btn btn-ghost btn-sm" onclick="App.quickStartGo('${taskId}', ${p.secs})">${p.label}</button>`
    ).join('');
    const customBtn = `<button class="btn btn-ghost btn-sm" onclick="App.quickStartCustom('${taskId}')">自定义</button>`;
    const plannedBtn = planned > 0
      ? `<button class="btn btn-primary btn-sm" onclick="App.quickStartGo('${taskId}', ${planned})">用计划 ${fmtDuration(planned)}</button>`
      : '';
    cf.innerHTML = `为「${esc(t.name)}」开启时间盒，选择预算：
      <button class="btn btn-ghost btn-sm" onclick="App.switchConfirmCancel()">取消</button>
      ${presetBtns}${customBtn}${plannedBtn}`;
    cf.classList.remove('off');
  }

  async function quickStartGo(taskId, secs) {
    switchConfirmCancel();
    // 若有活跃盒先关闭
    if (activeBox && activeBox.taskId !== taskId) {
      await closeBox();
    }
    await openBox(taskId, secs);
  }

  function quickStartCustom(taskId) {
    const input = prompt('输入预算时间（分钟）：', '30');
    if (input === null) return;
    const mins = parseFloat(input);
    if (isNaN(mins) || mins <= 0) { toast('请输入正数'); return; }
    quickStartGo(taskId, Math.round(mins * 60));
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function renderSidebar() {
    const sb = document.getElementById('sidebar');
    let topHtml;
    if (!activeBox) {
      topHtml = `
        <div class="cur-box">
          <div class="cur-label">无活跃时间盒</div>
          <div class="cur-name empty">选择或新建任务开始</div>
        </div>
        <div class="stats">
          <div class="stat stat-total"><div class="stat-label">总任务</div><div class="stat-num">${tasks.length}</div></div>
          <div class="stat stat-done"><div class="stat-label">已完成</div><div class="stat-num">${tasks.filter(t => t.done).length}</div></div>
        </div>`;
    } else {
      const task = tasks.find(t => t.id === activeBox.taskId);
      const name = task ? task.name : '(已删除)';
      const rem = activeBox.remainingSecs;
      const ot = activeBox.liveOvertimeSecs;
      const isOvertime = rem < 0;
      const isPaused = activeBox.status === 'paused';
      const pct = Math.min(100, activeBox.progressPct);
      const label = isOvertime ? '超出预算' : (isPaused ? '已暂停' : '时间盒进行中');

      const timerFaceClass = 'timer-face' + (isOvertime ? ' overtime' : (rem <= 60 && !isOvertime ? ' urgent' : '')) + (isPaused ? ' paused' : '');
      const progFillClass = 'prog-fill' + (isOvertime ? ' overtime' : (rem <= 60 && !isOvertime ? ' urgent' : ''));

      let btnsHtml;
      if (isPaused) {
        btnsHtml = `<button class="btn btn-primary btn-sm" onclick="App.resumeBox()">继续</button>
          <button class="btn btn-ghost btn-sm" onclick="App.extendBox(300)">+5分</button>
          <button class="btn btn-ghost btn-sm" onclick="App.closeBox()">${isOvertime ? '结束' : '关闭'}</button>`;
      } else if (isOvertime) {
        btnsHtml = `<button class="btn btn-ghost btn-sm" onclick="App.pauseBox()">暂停</button>
          <button class="btn btn-ghost btn-sm" onclick="App.extendBox(300)">+5分</button>
          <button class="btn btn-ghost btn-sm" onclick="App.extendBox(900)">+15分</button>
          <button class="btn btn-primary btn-sm" onclick="App.closeBox()">结束</button>`;
      } else {
        btnsHtml = `<button class="btn btn-ghost btn-sm" onclick="App.pauseBox()">暂停</button>
          <button class="btn btn-ghost btn-sm" onclick="App.extendBox(300)">+5分</button>
          <button class="btn btn-ghost btn-sm" onclick="App.extendBox(900)">+15分</button>
          <button class="btn btn-primary btn-sm" onclick="App.closeBox()">关闭</button>`;
      }

      topHtml = `
      <div class="timer-card${isOvertime ? ' overtime' : ''}">
        <div class="timer-label">${label}</div>
        <div class="${timerFaceClass}">${isOvertime ? '+' + fmtTime(ot) : fmtTime(Math.max(0, rem))}</div>
        <div class="prog-bg"><div class="${progFillClass}" style="width:${pct}%"></div></div>
        <div class="timer-btns">${btnsHtml}</div>
      </div>
      <div class="cur-box">
        <div class="cur-label">当前时间盒</div>
        <div class="cur-name">${esc(name)}</div>
        <div class="cur-time-stats">
          <span class="cur-time-stat total">⏱ 已用 ${fmtDuration(activeBox.workedSecs)}</span>
          <span class="cur-time-stat focus">预算 ${fmtDuration(activeBox.budgetSecs)}</span>
        </div>
      </div>
      <div class="stats">
        <div class="stat stat-total"><div class="stat-label">总任务</div><div class="stat-num">${tasks.length}</div></div>
        <div class="stat stat-done"><div class="stat-label">已完成</div><div class="stat-num">${tasks.filter(t => t.done).length}</div></div>
      </div>`;
    }
    sb.innerHTML = topHtml + '<div id="musicSection" class="music-section"></div>';
  }

  function renderMain() {
    const m = document.getElementById('taskList');
    let visible = settings.filter === 'pending' ? tasks.filter(t => !t.done) :
                  settings.filter === 'done' ? tasks.filter(t => t.done) : tasks;
    if (settings.dateFilter !== 'all') {
      visible = visible.filter(t => taskDateKey(t) === settings.dateFilter);
    }
    const cards = visible.map(t => {
      const isCur = activeBox && activeBox.taskId === t.id;
      const totalTime = t.focusSecs + t.overtimeSecs;
      const bodyClick = isCur ? '' : `onclick="App.switchTask('${t.id}','${jsEsc(t.name)}');"`;
      const priColor = { high: 'pri-high', mid: 'pri-mid', low: 'pri-low' }[t.priority] || 'pri-mid';
      const priLabel = { high: '高', mid: '中', low: '低' }[t.priority] || '中';
      const dateStr = taskDateKey(t);
      const html = `<div class="tcard${t.done ? ' done' : ''}${isCur ? ' active' : ''}">
        <div class="tcheck${t.done ? ' checked' : ''}" onclick="App.toggleDone('${t.id}')"></div>
        <div class="tbody" ${bodyClick}>
          <div class="t-title">${esc(t.name)}</div>
          ${t.desc ? `<div class="t-desc">${esc(t.desc)}</div>` : ''}
          ${dateStr ? `<div class="t-date">📅 ${dateStr}</div>` : ''}
          ${totalTime > 1 ? `<div class="t-times">
            <span class="t-time total">⏱ ${fmtDuration(totalTime)}</span>
            ${t.focusSecs > 1 ? `<span class="t-time focus">计划内 ${fmtDuration(t.focusSecs)}</span>` : ''}
            ${t.overtimeSecs > 1 ? `<span class="t-time ot">⚠ 超出 ${fmtDuration(t.overtimeSecs)}</span>` : ''}
          </div>` : ''}
        </div>
        <div class="tactions">
          <span class="pri ${priColor}">${priLabel}</span>
          ${isCur ? '' : `<button class="btn-icon play" title="开始计时" onclick="event.stopPropagation();App.quickStart('${t.id}')">▶</button>`}
          <button class="btn-icon" onclick="event.stopPropagation();App.modalOpen('${t.id}')">✎</button>
          <button class="btn-icon del" onclick="event.stopPropagation();App.confirmDelete('${t.id}','${jsEsc(t.name)}')">✕</button>
        </div>
      </div>`;
      return html;
    }).join('');

    const filters = [
      { key: 'all', label: '全部' },
      { key: 'pending', label: '进行中' },
      { key: 'done', label: '已完成' },
    ];
    const chips = filters.map(f => `<button class="chip${settings.filter === f.key ? ' on' : ''}" onclick="App.setFilter('${f.key}')">${f.label}</button>`).join('');

    // 日期筛选：取所有任务的创建日期，去重并降序排列
    const dateKeys = [...new Set(tasks.map(taskDateKey).filter(Boolean))].sort().reverse();
    const dateOpts = ['<option value="all">全部日期</option>']
      .concat(dateKeys.map(d => `<option value="${d}"${settings.dateFilter === d ? ' selected' : ''}>${d}</option>`))
      .join('');

    m.innerHTML = `
      <div class="sec-hd"><h2>任务列表</h2><span class="badge">${tasks.filter(t => !t.done).length} 进行中</span></div>
      <div class="filters">${chips}<select class="date-filter" onchange="App.setDateFilter(this.value)">${dateOpts}</select></div>
      <div class="tasks">${cards || '<div class="empty">暂无任务</div>'}</div>`;
  }

  function setTab(tab) {
    activeTab = tab;
    localStorage.setItem('tm_active_tab', tab);
    renderTabs();
  }

  function renderTabs() {
    document.querySelectorAll('.tab').forEach((el, i) => {
      const key = i === 0 ? 'tasks' : 'timeline';
      el.classList.toggle('on', activeTab === key);
    });
    const tl = document.getElementById('taskList');
    const tlPane = document.getElementById('timeline');
    if (tl) tl.classList.toggle('off', activeTab !== 'tasks');
    if (tlPane) tlPane.classList.toggle('off', activeTab !== 'timeline');
  }

  function render() {
    renderSidebar();
    renderTimeline();
    renderMain();
    renderMusic();
    renderTopbarStatus();
    renderTabs();
  }

  // ── 今日时间线（P0-2 + P1-3 计划vs实际）──
  function renderTimeline() {
    const el = document.getElementById('timeline');
    if (!el) return;
    if (!dayBoxes.length) {
      el.innerHTML = `<div class="sec-hd"><h2>今日时间线</h2></div><div class="empty">今天还没有已完成的时间盒</div>`;
      return;
    }
    // 按开始时间升序
    const boxes = [...dayBoxes].sort((a, b) => a.openedAt - b.openedAt);
    // 找到今天的工作时间范围（最早开盒到最晚关盒）
    const minTs = Math.min(...boxes.map(b => b.openedAt));
    const maxTs = Math.max(...boxes.map(b => b.closedAt));
    const span = Math.max(1, maxTs - minTs);

    const bars = boxes.map(b => {
      const left = (b.openedAt - minTs) / span * 100;
      const width = Math.max(2, (b.closedAt - b.openedAt) / span * 100);
      const t = tasks.find(x => x.id === b.taskId);
      const name = t ? t.name : (b.taskName || '(已删除)');
      const pri = (t && t.priority) || b.taskPriority || 'mid';
      const priCls = { high: 'tl-high', mid: 'tl-mid', low: 'tl-low' }[pri] || 'tl-mid';
      const planned = b.budgetSecs;
      const actual = b.focusSecs + b.overtimeSecs;
      const diff = actual - planned;
      const diffCls = diff > 1 ? 'tl-over' : (diff < -1 ? 'tl-under' : 'tl-ok');
      const diffStr = diff > 1 ? `+${fmtDuration(diff)}` : (diff < -1 ? `-${fmtDuration(-diff)}` : '吻合');
      const startStr = new Date(b.openedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const endStr = new Date(b.closedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      return `<div class="tl-row">
        <div class="tl-time">${startStr}–${endStr}</div>
        <div class="tl-bar-wrap">
          <div class="tl-bar ${priCls}" style="left:${left}%;width:${width}%" title="${esc(name)} · ${fmtDuration(actual)}"></div>
        </div>
        <div class="tl-name">${esc(name)}</div>
        <div class="tl-stats">
          <span class="tl-actual">实际 ${fmtDuration(actual)}</span>
          <span class="tl-diff ${diffCls}">${diffStr}</span>
        </div>
      </div>`;
    }).join('');

    const totalActual = boxes.reduce((s, b) => s + b.focusSecs + b.overtimeSecs, 0);
    const totalPlanned = boxes.reduce((s, b) => s + b.budgetSecs, 0);

    el.innerHTML = `
      <div class="sec-hd">
        <h2>今日时间线</h2>
        <span class="badge">${boxes.length} 个时间盒 · 实际 ${fmtDuration(totalActual)} / 计划 ${fmtDuration(totalPlanned)}</span>
      </div>
      <div class="tl-list">${bars}</div>`;
  }

  // ── 顶部全局状态条（P1-1）──
  function renderTopbarStatus() {
    const el = document.getElementById('topbarStatus');
    if (!el) return;
    if (!activeBox) {
      el.classList.add('off');
      el.innerHTML = '';
      return;
    }
    const task = tasks.find(t => t.id === activeBox.taskId);
    const name = task ? task.name : '当前任务';
    const rem = activeBox.remainingSecs;
    const ot = activeBox.liveOvertimeSecs;
    const isOvertime = rem < 0;
    const isPaused = activeBox.status === 'paused';
    const timeStr = isOvertime ? '+' + fmtTime(ot) : fmtTime(Math.max(0, rem));
    const dotCls = isPaused ? 'ts-paused' : (isOvertime ? 'ts-over' : 'ts-running');
    el.className = 'topbar-status ' + dotCls;
    el.innerHTML = `<span class="ts-dot"></span><span class="ts-name">${esc(name)}</span><span class="ts-time">${timeStr}</span>`;
  }

  function scrollToSidebar() {
    document.getElementById('sidebar').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function updateTimerDisplay() {
    if (!activeBox) return;
    const rem = activeBox.remainingSecs;
    const ot = activeBox.liveOvertimeSecs;
    const isOvertime = rem < 0;
    const isPaused = activeBox.status === 'paused';
    const pct = Math.min(100, activeBox.progressPct);

    const timerFace = document.querySelector('.timer-face');
    if (timerFace) {
      timerFace.textContent = isOvertime ? '+' + fmtTime(ot) : fmtTime(Math.max(0, rem));
      timerFace.className = 'timer-face' + (isOvertime ? ' overtime' : (rem <= 60 && !isOvertime ? ' urgent' : '')) + (isPaused ? ' paused' : '');
    }
    const progFill = document.querySelector('.prog-fill');
    if (progFill) {
      progFill.style.width = pct + '%';
      progFill.className = 'prog-fill' + (isOvertime ? ' overtime' : (rem <= 60 && !isOvertime ? ' urgent' : ''));
    }
    const timerLabel = document.querySelector('.timer-label');
    if (timerLabel) {
      timerLabel.textContent = isOvertime ? '超出预算' : (isPaused ? '已暂停' : '时间盒进行中');
    }
    const totalStat = document.querySelector('.cur-time-stat.total');
    if (totalStat) {
      totalStat.textContent = '⏱ 已用 ' + fmtDuration(activeBox.workedSecs);
    }
    const timerCard = document.querySelector('.timer-card');
    if (timerCard) {
      timerCard.classList.toggle('overtime', isOvertime);
    }
    updateOvertimeReminder(isOvertime, ot, activeBox);
    // 同步顶部状态条的时间显示
    const tsTime = document.querySelector('#topbarStatus .ts-time');
    if (tsTime) tsTime.textContent = isOvertime ? '+' + fmtTime(ot) : fmtTime(Math.max(0, rem));
    const tsEl = document.getElementById('topbarStatus');
    if (tsEl) {
      tsEl.className = 'topbar-status ' + (isPaused ? 'ts-paused' : (isOvertime ? 'ts-over' : 'ts-running'));
    }
  }

  // ── 超时多通道提醒（声音 + 浏览器通知 + reminder 卡片）──
  let reminderBeepEl = null;
  let reminderFiredStages = new Set();  // 已触发的超时阶段（0/1/5 分钟），避免重复
  let lastReminderBoxId = null;

  function ensureBeepEl() {
    if (!reminderBeepEl) {
      reminderBeepEl = document.createElement('audio');
      // 短促提示音：用 data URI 生成 0.3s 的 880Hz 正弦波
      reminderBeepEl.src = 'data:audio/wav;base64,UklGRsQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YaABAACA';
    }
    return reminderBeepEl;
  }

  function playBeep() {
    if (!settings.soundEnabled) return;
    try {
      const el = ensureBeepEl();
      el.currentTime = 0;
      el.play().catch(() => {});  // 忽略自动播放策略错误
    } catch (e) {}
  }

  async function ensureNotifyPermission() {
    if (!settings.notifyEnabled) return false;
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission !== 'denied') {
      const p = await Notification.requestPermission();
      return p === 'granted';
    }
    return false;
  }

  function fireNotification(title, body) {
    ensureNotifyPermission().then(ok => {
      if (ok) {
        try {
          new Notification(title, { body, icon: '/static/music/liszt-liebestraum-no3.mp3'.replace('.mp3', '.png') });
        } catch (e) {}
      }
    });
  }

  function updateOvertimeReminder(isOvertime, otSecs, box) {
    const reminderEl = document.getElementById('reminder');
    if (!reminderEl) return;

    // 盒子切换时重置阶段
    if (box && box.id !== lastReminderBoxId) {
      lastReminderBoxId = box.id;
      reminderFiredStages = new Set();
      reminderEl.classList.add('off');
    }

    if (!isOvertime || !box) {
      reminderEl.classList.add('off');
      return;
    }

    const task = tasks.find(t => t.id === box.taskId);
    const taskName = task ? task.name : '当前任务';
    // 阶段：0分钟（刚超时）、1分钟、5分钟
    const stage = otSecs >= 300 ? 5 : (otSecs >= 60 ? 1 : 0);
    if (reminderFiredStages.has(stage)) return;  // 该阶段已触发
    reminderFiredStages.add(stage);

    playBeep();

    const subText = stage === 0 ? '刚刚超出预算时间' :
                    stage === 1 ? '已超出 1 分钟' : '已超出 5 分钟，建议结束或延长';
    fireNotification('时间盒超时: ' + taskName, subText);

    // 填充 reminder 卡片
    reminderEl.innerHTML = `
      <div class="rem-head">
        <div class="rem-bell">!</div>
        <div class="rem-info">
          <div class="rem-title">时间盒已超时</div>
          <div class="rem-sub">${esc(subText)}</div>
        </div>
        <button class="rem-close" onclick="App.dismissReminder()">×</button>
      </div>
      <div class="rem-body">
        <div class="rem-task">${esc(taskName)}</div>
        <div class="rem-desc">已超出 ${fmtTime(otSecs)}，可选择延长或结束时间盒</div>
        <div class="rem-btns">
          <button class="btn btn-ghost btn-sm" onclick="App.extendBox(300);App.dismissReminder()">+5 分钟</button>
          <button class="btn btn-ghost btn-sm" onclick="App.extendBox(900);App.dismissReminder()">+15 分钟</button>
          <button class="btn btn-primary btn-sm" onclick="App.closeBox();App.dismissReminder()">结束</button>
        </div>
      </div>`;
    reminderEl.classList.remove('off');
  }

  function dismissReminder() {
    const el = document.getElementById('reminder');
    if (el) el.classList.add('off');
  }

  let tickInterval = null;
  function startTick() {
    if (tickInterval) return;
    tickInterval = setInterval(async () => {
      const b = await api('GET', '/boxes/active');
      if (b === undefined) return;  // 网络错误，不改状态
      if (b) {
        const boxChanged = !activeBox || activeBox.id !== b.id;
        activeBox = b;
        if (boxChanged) render();       // 盒子变了（新开/切换），完整渲染
        else updateTimerDisplay();      // 同一盒，仅更新计时数字
      } else {
        if (activeBox) { activeBox = null; render(); }  // 盒子被关闭
      }
    }, 1000);
  }

  // ── Music ──
  const PLAYLIST = [
    { name: '升华之夜（弦乐版）Op.4', artist: '勋伯格', url: '/music/verklarte-nacht.mp3' },
    { name: '爱之梦 No.3 (Liebesträume S.541)', artist: '李斯特', url: '/music/liszt-liebestraum-no3.mp3' },
    { name: '匈牙利狂想曲 No.2 (Hungarian Rhapsody S.244)', artist: '李斯特', url: '/music/liszt-hungarian-rhapsody-no2.mp3' },
    { name: '钟 (La Campanella, 帕格尼尼练习曲 S.141)', artist: '李斯特', url: '/music/liszt-la-campanella.mp3' },
    { name: '叹息 (Un Sospiro, 三首音乐会练习曲 S.144)', artist: '李斯特', url: '/music/liszt-un-sospiro.mp3' },
    { name: '第5交响曲 I.葬礼进行曲 (Symphony No.5)', artist: '马勒', url: '/music/mahler-sym5-mvt1.mp3' },
    { name: '第5交响曲 II.暴风雨般激动 (Symphony No.5)', artist: '马勒', url: '/music/mahler-sym5-mvt2.mp3' },
    { name: '第5交响曲 III.谐谑曲 (Symphony No.5)', artist: '马勒', url: '/music/mahler-sym5-mvt3.mp3' },
    { name: '第5交响曲 IV.小柔板 (Symphony No.5)', artist: '马勒', url: '/music/mahler-sym5-mvt4.mp3' },
    { name: '第5交响曲 V.回旋曲-终曲 (Symphony No.5)', artist: '马勒', url: '/music/mahler-sym5-mvt5.mp3' },
    { name: '第2钢琴协奏曲 I.中板 (PC No.2 Op.18)', artist: '拉赫玛尼诺夫', url: '/music/rachmaninoff-pc2-mvt1.mp3' },
    { name: '第2钢琴协奏曲 II.绵延的柔板 (PC No.2 Op.18)', artist: '拉赫玛尼诺夫', url: '/music/rachmaninoff-pc2-mvt2.mp3' },
    { name: '第2钢琴协奏曲 III.谐谑的快板 (PC No.2 Op.18)', artist: '拉赫玛尼诺夫', url: '/music/rachmaninoff-pc2-mvt3.mp3' },
    { name: '第3钢琴协奏曲 I.不过分的快板 (PC No.3 Op.30)', artist: '拉赫玛尼诺夫', url: '/music/rachmaninoff-pc3-mvt1.mp3' },
    { name: '第3钢琴协奏曲 II.间奏曲-柔板 (PC No.3 Op.30)', artist: '拉赫玛尼诺夫', url: '/music/rachmaninoff-pc3-mvt2.mp3' },
    { name: '第3钢琴协奏曲 III.终曲-诙谐的快板 (PC No.3 Op.30)', artist: '拉赫玛尼诺夫', url: '/music/rachmaninoff-pc3-mvt3.mp3' },
    { name: '第9交响曲"自新世界" I.柔板-如火般热烈 (Symphony No.9)', artist: '德沃夏克', url: '/music/dvorak-sym9-mvt1.mp3' },
    { name: '第9交响曲"自新世界" II.广板 (Symphony No.9)', artist: '德沃夏克', url: '/music/dvorak-sym9-mvt2.mp3' },
    { name: '第9交响曲"自新世界" III.谐谑曲 (Symphony No.9)', artist: '德沃夏克', url: '/music/dvorak-sym9-mvt3.mp3' },
    { name: '第9交响曲"自新世界" IV.火热的快板 (Symphony No.9)', artist: '德沃夏克', url: '/music/dvorak-sym9-mvt4.mp3' },
    { name: '第6交响曲"悲怆" I.柔板-不过分的快板 (Symphony No.6 Op.74)', artist: '柴可夫斯基', url: '/music/tchaikovsky-sym6-mvt1.mp3' },
    { name: '第6交响曲"悲怆" II.优雅的快板 (Symphony No.6 Op.74)', artist: '柴可夫斯基', url: '/music/tchaikovsky-sym6-mvt2.mp3' },
    { name: '第6交响曲"悲怆" III.活泼的极快板 (Symphony No.6 Op.74)', artist: '柴可夫斯基', url: '/music/tchaikovsky-sym6-mvt3.mp3' },
    { name: '第6交响曲"悲怆" IV.终曲-悲叹的柔板 (Symphony No.6 Op.74)', artist: '柴可夫斯基', url: '/music/tchaikovsky-sym6-mvt4.mp3' },
    { name: '小提琴协奏曲 I.中庸的快板 (VC Op.35)', artist: '柴可夫斯基', url: '/music/tchaikovsky-violin-concerto-mvt1.mp3' },
    { name: '小提琴协奏曲 II.短歌-行板 (VC Op.35)', artist: '柴可夫斯基', url: '/music/tchaikovsky-violin-concerto-mvt2.mp3' },
    { name: '小提琴协奏曲 III.活泼的极快板 (VC Op.35)', artist: '柴可夫斯基', url: '/music/tchaikovsky-violin-concerto-mvt3.mp3' },
    { name: '查拉图斯特拉如是说 上半部 (Op.30)', artist: '理查·施特劳斯', url: '/music/strauss-zarathustra-part1.mp3' },
    { name: '查拉图斯特拉如是说 下半部 (Op.30)', artist: '理查·施特劳斯', url: '/music/strauss-zarathustra-part2.mp3' },
    { name: '钢琴协奏曲 Op.16 (完整)', artist: '格里格', url: '/music/grieg-piano-concerto.mp3' },
    { name: '第2钢琴协奏曲 I.不过分的快板 (PC No.2 Op.83)', artist: '勃拉姆斯', url: '/music/brahms-pc2-mvt1.mp3' },
    { name: '第2钢琴协奏曲 II.热情的快板 (PC No.2 Op.83)', artist: '勃拉姆斯', url: '/music/brahms-pc2-mvt2.mp3' },
    { name: '第2钢琴协奏曲 III.行板 (PC No.2 Op.83)', artist: '勃拉姆斯', url: '/music/brahms-pc2-mvt3.mp3' },
    { name: '第2钢琴协奏曲 IV.优雅的小快板 (PC No.2 Op.83)', artist: '勃拉姆斯', url: '/music/brahms-pc2-mvt4.mp3' },
  ];
  let musicEl = null;
  let musicIdx = -1;
  let musicOpen = false;
  let musicVol = 0.5;
  let loopMode = 'list';  // 'list' 或 'single'

  function initMusic() {
    musicEl = document.createElement('audio');
    musicEl.loop = false;
    musicEl.volume = musicVol;
    musicEl.preload = 'metadata';
    musicEl.addEventListener('ended', () => {
      if (loopMode === 'single') {
        musicPlay(musicIdx);
      } else if (musicIdx < PLAYLIST.length - 1) {
        musicPlay(musicIdx + 1);
      } else {
        musicIdx = -1;
        renderMusic();
      }
    });
    musicEl.addEventListener('timeupdate', () => renderMusicProgress());
    const saved = localStorage.getItem('tm_music_vol');
    if (saved) { musicVol = parseFloat(saved); musicEl.volume = musicVol; }
    const savedLoop = localStorage.getItem('tm_music_loop');
    if (savedLoop) { loopMode = savedLoop; }
  }

  function musicPlay(idx) {
    if (!musicEl) initMusic();
    if (idx === musicIdx && !musicEl.paused) {
      musicEl.pause();
      renderMusic();
      return;
    }
    if (idx >= 0 && idx < PLAYLIST.length) {
      musicIdx = idx;
      musicEl.src = PLAYLIST[idx].url;
      musicEl.load();
      const p = musicEl.play();
      if (p) p.catch(e => console.warn('play error:', e.message));
    }
    renderMusic();
  }

  function musicToggle() {
    if (!musicEl) { initMusic(); musicPlay(0); return; }
    if (musicEl.paused) {
      if (musicIdx < 0) musicPlay(0);
      else {
        const p = musicEl.play();
        if (p) p.catch(e => console.warn('play error:', e.message));
      }
    } else {
      musicEl.pause();
    }
    renderMusic();
  }

  function musicSetVol(v) {
    musicVol = v;
    if (musicEl) musicEl.volume = v;
    localStorage.setItem('tm_music_vol', v);
  }

  function musicSeek(e) {
    if (!musicEl || !musicEl.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    musicEl.currentTime = pct * musicEl.duration;
    renderMusicProgress();
  }

  function toggleLoopMode() {
    loopMode = loopMode === 'list' ? 'single' : 'list';
    localStorage.setItem('tm_music_loop', loopMode);
    renderMusic();
  }

  function fmtMusicTime(s) {
    if (!s || !isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  }

  function renderMusicProgress() {
    const fill = document.querySelector('.music-progress-fill');
    const curEl = document.querySelector('.music-time-cur');
    const durEl = document.querySelector('.music-time-dur');
    if (fill && musicEl && musicEl.duration) {
      fill.style.width = (musicEl.currentTime / musicEl.duration * 100) + '%';
    }
    if (curEl) curEl.textContent = fmtMusicTime(musicEl ? musicEl.currentTime : 0);
    if (durEl) durEl.textContent = fmtMusicTime(musicEl ? musicEl.duration : 0);
  }

  function renderMusic() {
    const el = document.getElementById('musicSection');
    if (!el) return;
    const playing = musicEl && !musicEl.paused;
    const cur = musicIdx >= 0 ? PLAYLIST[musicIdx] : null;
    const statusText = cur ? (playing ? '▶ ' : '⏸ ') + cur.name + ' — ' + cur.artist : '背景音乐';

    const trackList = PLAYLIST.map((t, i) => `
      <div class="music-track${i === musicIdx ? ' active' : ''}" onclick="App.musicPlay(${i})">
        <span class="track-num">${i === musicIdx && playing ? '▶' : (i + 1)}</span>
        <span class="track-name">${esc(t.name)}</span>
        <span class="track-artist">${esc(t.artist)}</span>
      </div>`).join('');

    el.innerHTML = `
      <div class="music-header" onclick="App.musicToggleSection()">
        <span>♪</span>
        <span class="now-playing">${statusText}</span>
        <span class="arrow${musicOpen ? ' open' : ''}">▶</span>
      </div>
      <div class="music-body${musicOpen ? ' open' : ''}">
        <div class="music-track-list">${trackList}</div>
        <div class="music-controls">
          <button class="music-btn" onclick="App.musicPrev()">⏮</button>
          <button class="music-btn play" onclick="App.musicToggle()">${playing ? '⏸' : '▶'}</button>
          <button class="music-btn" onclick="App.musicNext()">⏭</button>
        </div>
        <div class="music-progress" onclick="App.musicSeek(event)">
          <div class="music-progress-fill" style="width:0%"></div>
        </div>
        <div class="music-time">
          <span class="music-time-cur">0:00</span>
          <span class="music-time-dur">0:00</span>
        </div>
        <div class="music-volume">
          <span>🔊</span>
          <input type="range" min="0" max="1" step="0.05" value="${musicVol}" oninput="App.musicSetVol(parseFloat(this.value))">
        </div>
        <div class="music-loop">
          <button class="music-loop-btn${loopMode === 'list' ? ' active' : ''}" onclick="App.toggleLoopMode()" title="循环模式">
            ${loopMode === 'list' ? '列表循环' : '单曲循环'}
          </button>
        </div>
      </div>`;
  }

  function musicToggleSection() {
    musicOpen = !musicOpen;
    renderMusic();
  }

  function musicPrev() { if (musicIdx > 0) musicPlay(musicIdx - 1); }
  function musicNext() { if (musicIdx < PLAYLIST.length - 1) musicPlay(musicIdx + 1); }

  // ── Modals ──
  let modalMode = 'add', modalEditId = null;
  function modalOpen(id) {
    modalMode = id ? 'edit' : 'add';
    modalEditId = id;
    const t = id ? tasks.find(x => x.id === id) : null;
    const plannedMins = t && t.plannedSecs ? Math.round(t.plannedSecs / 60) : '';
    const ov = document.getElementById('overlay');
    ov.innerHTML = `<div class="modal">
      <h3>${id ? '编辑任务' : '新建任务'}</h3>
      <div class="field"><label>任务名称</label><input type="text" id="mName" value="${t ? esc(t.name) : ''}" placeholder="例如：完成需求文档" maxlength="80"></div>
      <div class="field"><label>描述</label><textarea id="mDesc" placeholder="备注">${t ? esc(t.desc || '') : ''}</textarea></div>
      <div class="field"><label>优先级</label>
        <select id="mPri">
          <option value="mid" ${t && t.priority === 'mid' ? 'selected' : ''}>中</option>
          <option value="high" ${t && t.priority === 'high' ? 'selected' : ''}>高</option>
          <option value="low" ${t && t.priority === 'low' ? 'selected' : ''}>低</option>
        </select>
      </div>
      <div class="field"><label>计划时间（分钟）</label><input type="number" id="mPlanned" value="${plannedMins}" placeholder="例如：25" min="0" step="5"></div>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="App.modalClose()">取消</button>
        <button class="btn btn-primary" onclick="App.modalSave()">保存</button>
      </div>
    </div>`;
    ov.classList.remove('off');
    setTimeout(() => document.getElementById('mName')?.focus(), 100);
  }

  function modalClose() {
    document.getElementById('overlay').classList.add('off');
    modalEditId = null;
  }

  async function modalSave() {
    const name = document.getElementById('mName').value.trim();
    if (!name) { document.getElementById('mName').focus(); return; }
    const desc = document.getElementById('mDesc').value.trim();
    const pri = document.getElementById('mPri').value;
    const plannedMin = document.getElementById('mPlanned').value;
    const plannedSecs = plannedMin ? parseFloat(plannedMin) * 60 : 0;

    if (modalMode === 'add') {
      await addTask(name, desc, pri, plannedSecs);
    } else {
      const r = await api('PUT', '/tasks/' + modalEditId, { name, desc, priority: pri, plannedSecs });
      if (r) {
        const idx = tasks.findIndex(t => t.id === modalEditId);
        if (idx >= 0) tasks[idx] = r;
      }
    }
    modalClose();
    render();
  }

  function confirmDelete(id, name) {
    const ov = document.getElementById('overlay');
    ov.innerHTML = `<div class="modal">
      <h3>删除任务？</h3>
      <p style="color:var(--c-gray-600);margin-bottom:20px">确定删除「${esc(name)}」？此操作不可撤销</p>
      <div class="modal-foot">
        <button class="btn btn-ghost" onclick="App.modalClose()">取消</button>
        <button class="btn btn-danger" onclick="App.deleteTask('${id}');App.modalClose()">删除</button>
      </div>
    </div>`;
    ov.classList.remove('off');
  }

  // ── Float window sync ──
  let floatWin = null;
  const bc = new BroadcastChannel('task-manager-sync');
  bc.onmessage = (e) => {
    if (e.data.type === 'float-opened') {
      document.getElementById('fwBadge').classList.remove('off');
    }
    if (e.data.type === 'float-closed') {
      document.getElementById('fwBadge').classList.add('off');
      floatWin = null;
    }
  };

  // ── Public API ──
  return {
    retryConnect: loadAll,
    startTick,  // 公开 tick 函数
    floatShow: () => { floatWin = window.open('/float.html', 'taskTimerFloat', 'width=230,height=260'); },
    floatFocus: () => { if (floatWin && !floatWin.closed) floatWin.focus(); },
    scrollToSidebar, setTab,
    openBox, closeBox, extendBox, toggleDone, deleteTask, setCurrent, switchTask, switchConfirmCancel, switchConfirmYes, confirmStopBox,
    quickStart, quickStartGo, quickStartCustom,
    modalOpen, modalClose, modalSave, confirmDelete,
    setFilter: (f) => { settings.filter = f; api('PUT', '/settings', { filter: f }); render(); },
    setDateFilter: (d) => { settings.dateFilter = d; localStorage.setItem('tm_date_filter', d); render(); },
    pauseBox, resumeBox, dismissReminder,
    musicPlay, musicToggle, musicPrev, musicNext, musicSetVol, musicToggleSection, musicSeek, toggleLoopMode,
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  App.retryConnect();
  App.startTick();  // 启动计时器秒级更新
  setInterval(() => App.retryConnect(), 10000);
});
