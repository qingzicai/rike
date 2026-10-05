/* 日课 — 每日打卡
 * 数据默认存在浏览器 localStorage；填入 Google Apps Script 网址和口令后，可通过 Google 表格多设备同步。
 */
(() => {
  'use strict';

  const STORE_KEY = 'rike.state.v1';
  const SETTINGS_KEY = 'rike.settings.v1';
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const TAGS = ['超时', '被打断', '精力不足', '临时事务', '拖延', '计划过多', '状态很好'];
  const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
  const DEFAULT_TASKS = [
    ['t-words', 'Between the words', 15],
    ['t-stats', 'Statistics', 30],
    ['t-exercise', 'Exercise', 60],
    ['t-piano', 'Piano', 20],
    ['t-creative', 'Creative writing', 20],
    ['t-academic', 'Academic writing', 60],
  ].map(([id, name, minutes]) => ({ id, name, minutes, days: [...ALL_DAYS], link: '' }));

  const main = document.getElementById('main');
  const syncEl = document.getElementById('syncStatus');

  /* ---------------- utils ---------------- */
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const isYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const todayStr = () => ymd(new Date());
  const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
  const weekStart = s => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
  const weekDates = start => Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const monthAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const round5 = m => Math.max(5, Math.round(m / 5) * 5);
  const fmtMin = m => { m = Math.round(m || 0); const h = Math.floor(m / 60), r = m % 60; if (!h) return `${r} 分钟`; return r ? `${h} 小时 ${r} 分` : `${h} 小时`; };
  const hm = m => { const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h${r ? r + 'm' : ''}` : `${r}m`; };
  const mdLabel = s => { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日`; };
  const wdName = s => '星期' + WD[parseYmd(s).getDay()];
  const fmtTime = ts => { const d = new Date(ts); return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const clampMin = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(600, Math.max(0, n)) : 0; };
  const overLimit = t => t.minutes + Math.max(5, Math.round(t.minutes * 0.2));
  const isOver = t => t.actual != null && t.actual > overLimit(t);
  const safeLink = v => (/^https?:\/\//i.test(v || '') ? v : '');
  const rangeLabel = start => {
    const end = addDays(start, 6);
    const y = parseYmd(start).getFullYear() !== new Date().getFullYear() ? `${parseYmd(start).getFullYear()}年 ` : '';
    return `${y}${mdLabel(start)} – ${mdLabel(end)}`;
  };

  /* ---------------- state ---------------- */
  const blankState = () => ({
    version: 1,
    template: { updatedAt: 0, tasks: DEFAULT_TASKS.map(t => ({ ...t, days: [...t.days] })) },
    days: {},
  });
  function normalize(s) {
    const b = blankState();
    if (!s || typeof s !== 'object') return b;
    return {
      version: 1,
      template: s.template && Array.isArray(s.template.tasks) ? s.template : b.template,
      days: s.days && typeof s.days === 'object' ? s.days : {},
    };
  }
  function loadJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }

  let state = normalize(loadJSON(STORE_KEY));
  const settings = Object.assign({ url: '', token: '', lastSync: 0 }, loadJSON(SETTINGS_KEY) || {});
  const syncOn = () => !!(settings.url && settings.token);

  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch { toast('浏览器存储写入失败，请到「固定事项」页导出备份'); }
  }
  function save() { persist(); scheduleSync(); }
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  const touch = d => { d.updatedAt = Date.now(); };

  /* ---------------- day records ---------------- */
  const tplIndex = () => new Map(state.template.tasks.map((t, i) => [t.id, i]));
  const tplFind = id => state.template.tasks.find(t => t.id === id);
  const scheduledFor = date => { const wd = parseYmd(date).getDay(); return state.template.tasks.filter(t => t.days.includes(wd)); };
  const fromTpl = t => ({ id: uid(), tid: t.id, name: t.name, minutes: t.minutes, done: false, actual: null });
  const newDay = (date, updatedAt) => ({ tasks: scheduledFor(date).map(fromTpl), note: '', tags: [], skipped: [], updatedAt });

  // 今天及以后：打开时按固定事项自动生成。updatedAt=0 表示“还没动过”，同步时让位给有改动的版本。
  function ensureDay(date) {
    if (!state.days[date]) { state.days[date] = newDay(date, 0); persist(); }
    return state.days[date];
  }

  function sortTasks(d) {
    const idx = tplIndex();
    d.tasks = d.tasks
      .map((t, i) => [t, t.tid && idx.has(t.tid) ? idx.get(t.tid) : 1000 + i])
      .sort((a, b) => a[1] - b[1])
      .map(x => x[0]);
  }

  // 固定事项改动后，同步到今天及以后已生成的日子；已完成的项和过去的记录不动。
  function applyTemplate() {
    const t0 = todayStr();
    for (const [date, d] of Object.entries(state.days)) {
      if (date < t0) continue;
      const sched = scheduledFor(date);
      const ids = new Set(sched.map(t => t.id));
      const skipped = d.skipped || [];
      d.tasks = d.tasks.filter(x => !x.tid || x.done || ids.has(x.tid));
      for (const t of sched) {
        const ex = d.tasks.find(x => x.tid === t.id);
        if (ex) { if (!ex.done) { ex.name = t.name; ex.minutes = t.minutes; } }
        else if (!skipped.includes(t.id)) d.tasks.push(fromTpl(t));
      }
      sortTasks(d);
      if (d.updatedAt) touch(d);
    }
  }
  function tplChanged() { state.template.updatedAt = Date.now(); applyTemplate(); save(); }

  /* ---------------- aggregation & analysis ---------------- */
  function aggregate(dates) {
    const t0 = todayStr();
    const idx = tplIndex();
    const days = dates.filter(d => d <= t0 && state.days[d]).map(date => ({ date, ...state.days[date] }));
    const map = new Map();
    const tagCount = {};
    const totals = { items: 0, done: 0, plan: 0, donePlan: 0, actual: 0, actualN: 0 };
    const dayRates = [];
    for (const day of days) {
      let dn = 0;
      for (const t of day.tasks) {
        const k = t.tid || 'n:' + t.name;
        if (!map.has(k)) {
          map.set(k, { key: k, name: t.name, order: t.tid && idx.has(t.tid) ? idx.get(t.tid) : 1000 + map.size,
            n: 0, done: 0, planSum: 0, actualSum: 0, actualN: 0, over: 0 });
        }
        const s = map.get(k);
        s.name = t.name; s.n++; s.planSum += t.minutes;
        totals.items++; totals.plan += t.minutes;
        if (t.done) { s.done++; dn++; totals.done++; totals.donePlan += t.minutes; }
        if (t.actual != null) {
          s.actualSum += t.actual; s.actualN++; totals.actual += t.actual; totals.actualN++;
          if (isOver(t)) s.over++;
        }
      }
      for (const tag of day.tags || []) tagCount[tag] = (tagCount[tag] || 0) + 1;
      const n = day.tasks.length;
      dayRates.push({ date: day.date, wd: parseYmd(day.date).getDay(), done: dn, n, rate: n ? dn / n : null, full: n > 0 && dn === n });
    }
    const tasks = [...map.values()].sort((a, b) => a.order - b.order);
    return { dates, days, tasks, tagCount, totals, dayRates };
  }

  function suggestions(a, { isPastWeek }) {
    const out = [];
    const nDays = a.days.length;
    if (!nDays) return out;
    const T = a.totals;
    const rate = T.items ? T.done / T.items : 0;
    if (isPastWeek && nDays < 5) {
      out.push(`这一周只有 ${nDays} 天有记录。先把“每天打开一次”固定下来，比如睡前花两分钟勾选、写一句 note，周报才有依据。`);
    }
    for (const s of a.tasks) {
      const avgPlan = Math.round(s.planSum / s.n);
      const r = s.done / s.n;
      const avgAct = s.actualN ? Math.round(s.actualSum / s.actualN) : null;
      if (s.n >= 3 && r < 0.5) {
        out.push(`「${s.name}」完成率 ${pct(s.done, s.n)}%。可以先把时长从 ${avgPlan} 分钟降到 ${round5(avgPlan * 0.6)} 分钟，保住“每天都碰一下”；或者在「固定事项」里改成每周 3–4 次。`);
      } else if (s.over >= 2 && avgAct) {
        out.push(`「${s.name}」超时 ${s.over} 次，平均实际 ${avgAct} 分钟，计划是 ${avgPlan} 分钟。要么把计划改成 ${round5(avgAct)} 分钟，要么开始前先定一个收尾点（比如“写完这一段就停”）。`);
      } else if (s.actualN >= 3 && avgAct < avgPlan * 0.7 && r >= 0.8) {
        out.push(`「${s.name}」通常 ${avgAct} 分钟就做完了，比计划的 ${avgPlan} 分钟短。多出来的时间可以让给完成率低的项目。`);
      }
    }
    const tc = a.tagCount;
    if ((tc['计划过多'] || 0) >= 2 || (nDays >= 3 && rate < 0.6)) {
      const avgDone = Math.round(T.donePlan / nDays);
      const avgPlan = Math.round(T.plan / nDays);
      out.push(`每天平均完成约 ${fmtMin(avgDone)} 的计划量，而计划是 ${fmtMin(avgPlan)}。下周把每日总量先压到 ${fmtMin(round5(Math.max(avgDone * 1.1, 30)))} 左右，连续完成几天后再加。`);
    }
    if ((tc['被打断'] || 0) >= 2) out.push(`有 ${tc['被打断']} 天提到被打断。把需要连续专注的项目放进一个固定的、关掉通知的时段，其余的穿插在零碎时间里。`);
    if ((tc['精力不足'] || 0) >= 2) out.push(`有 ${tc['精力不足']} 天精力不足。把最费脑的一项挪到一天里状态最好的时段，体力型和轻松的项目放后面。`);
    if ((tc['拖延'] || 0) >= 2) out.push(`有 ${tc['拖延']} 天提到拖延。试试只承诺“先做 5 分钟”，开始之后再决定要不要做满。`);
    if ((tc['临时事务'] || 0) >= 2) out.push(`临时事务出现了 ${tc['临时事务']} 次。每天留出 30 分钟空白，不排事项，专门接住突发的事。`);
    if ((tc['超时'] || 0) >= 2 && !a.tasks.some(s => s.over >= 2)) {
      out.push(`note 里有 ${tc['超时']} 天提到超时，但实际用时填得不多。勾选时顺手填一下“实际”分钟数，下周就能看出是哪一项在超时。`);
    }
    const rated = a.dayRates.filter(x => x.rate != null);
    if (rated.length >= 4) {
      const avg = rated.reduce((s, x) => s + x.rate, 0) / rated.length;
      const worst = rated.reduce((m, x) => (x.rate < m.rate ? x : m), rated[0]);
      if (avg - worst.rate >= 0.3) {
        out.push(`星期${WD[worst.wd]}的完成率（${pct(worst.rate, 1)}%）明显低于这周平均（${pct(avg, 1)}%）。如果这一天本来就忙，可以在「固定事项」里给它去掉一两项。`);
      }
    }
    if (!out.length) {
      out.push(rate >= 0.85
        ? '这一周节奏稳定，没有明显的问题。保持现有安排；想加量的话，一次只给一项加 5–10 分钟。'
        : '数据还不多，看不出明显规律。继续勾选、填实际用时和 note，下周的分析会更具体。');
    }
    return out;
  }

  /* ---------------- export notes as text ---------------- */
  function exportText(dates, title) {
    const t0 = todayStr();
    const a = aggregate(dates);
    const T = a.totals;
    const L = [`# 日课记录：${title}`, ''];
    if (!a.days.length) return L.concat('这段时间没有打卡记录。').join('\n');
    L.push(`记录了 ${a.days.length} 天，完成 ${T.done} / ${T.items} 项（${pct(T.done, T.items)}%）。计划总时长 ${fmtMin(T.plan)}，其中已完成的部分 ${fmtMin(T.donePlan)}。${T.actualN ? `填写了实际用时的 ${T.actualN} 项共用时 ${fmtMin(T.actual)}。` : ''}`);
    L.push(`（超时的标准：实际用时超过计划 20%，且至少多 5 分钟）`, '', '## 各项情况');
    for (const s of a.tasks) {
      const avgAct = s.actualN ? `平均实际 ${Math.round(s.actualSum / s.actualN)} 分钟` : '未填实际用时';
      L.push(`- ${s.name}：完成 ${s.done}/${s.n}，计划 ${Math.round(s.planSum / s.n)} 分钟，${avgAct}${s.over ? `，超时 ${s.over} 次` : ''}`);
    }
    const tags = Object.entries(a.tagCount).sort((x, y) => y[1] - x[1]);
    if (tags.length) L.push('', '## 原因标签', tags.map(([k, v]) => `${k} ×${v}`).join('、'));
    L.push('', '## 每天的记录');
    for (const d of a.days) {
      const done = d.tasks.filter(t => t.done), miss = d.tasks.filter(t => !t.done);
      L.push('', `### ${mdLabel(d.date)} ${wdName(d.date)}（${done.length}/${d.tasks.length}）`);
      if (done.length) L.push(`- 完成：${done.map(t => t.name).join('、')}`);
      if (miss.length) L.push(`- 未完成：${miss.map(t => t.name).join('、')}`);
      const acts = d.tasks.filter(t => t.actual != null);
      if (acts.length) L.push(`- 实际用时：${acts.map(t => `${t.name} ${t.actual} 分（计划 ${t.minutes}${isOver(t) ? '，超时' : ''}）`).join('；')}`);
      if ((d.tags || []).length) L.push(`- 标签：${d.tags.join('、')}`);
      if ((d.note || '').trim()) L.push(`- Note：${d.note.trim().replace(/\n+/g, ' / ')}`);
    }
    const missing = dates.filter(x => x <= t0 && !state.days[x]);
    if (missing.length) L.push('', `没有打卡记录的日子：${missing.map(mdLabel).join('、')}`);
    return L.join('\n');
  }
  const exportScope = el => (el.dataset.scope === 'month'
    ? { dates: monthDatesOf(el.dataset.key), title: `${el.dataset.key.replace('-', '年')}月`, file: `日课-${el.dataset.key}.md` }
    : { dates: weekDates(el.dataset.key), title: rangeLabel(el.dataset.key), file: `日课-${el.dataset.key}周.md` });
  function monthDatesOf(ym) {
    const [y, m] = ym.split('-').map(Number);
    return Array.from({ length: new Date(y, m, 0).getDate() }, (_, i) => ymd(new Date(y, m - 1, i + 1)));
  }
  const exportButtons = (scope, key) => `
      <div class="row export">
        <button class="btn" data-act="export-copy" data-scope="${scope}" data-key="${key}">复制${scope === 'month' ? '本月' : '这周'}记录</button>
        <button class="btn" data-act="export-md" data-scope="${scope}" data-key="${key}">下载 .md</button>
      </div>`;
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('已复制，可以直接粘贴给 AI');
  }
  function downloadFile(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------------- routing ---------------- */
  function defaultReportWeek() {
    const t0 = todayStr();
    const ws = weekStart(t0);
    const n = weekDates(ws).filter(d => d < t0 && state.days[d]).length;
    return n >= 3 ? ws : addDays(ws, -7);
  }
  function route() {
    const [v, arg] = location.hash.replace(/^#\/?/, '').split('/');
    if (v === 'week') return { view: 'week', start: weekStart(isYmd(arg) ? arg : todayStr()) };
    if (v === 'month') return { view: 'month', ym: /^\d{4}-\d{2}$/.test(arg || '') ? arg : todayStr().slice(0, 7) };
    if (v === 'report') return { view: 'report', start: isYmd(arg) ? weekStart(arg) : defaultReportWeek() };
    if (v === 'settings') return { view: 'settings' };
    return { view: 'day', date: isYmd(arg) ? arg : todayStr() };
  }

  let current = route();
  let anim = null;        // 刚勾选的那一项，播放划线动画
  let stampAnim = false;  // 刚全部完成，播放盖章动画

  function render() {
    current = route();
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.view === current.view));
    const views = { day: viewDay, week: viewWeek, month: viewMonth, report: viewReport, settings: viewSettings };
    main.innerHTML = views[current.view](current);
    anim = null; stampAnim = false;
  }
  function softRender() {
    const a = document.activeElement;
    if (a && main.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) return;
    render();
  }

  /* ---------------- views ---------------- */
  function viewDay({ date }) {
    const t0 = todayStr();
    const d = date >= t0 ? ensureDay(date) : state.days[date];
    const dt = parseYmd(date);
    const yearPart = dt.getFullYear() !== new Date().getFullYear() ? `${dt.getFullYear()}年 ` : '';
    const rel = date === t0 ? '今天' : date === addDays(t0, -1) ? '昨天' : date === addDays(t0, 1) ? '明天' : '';
    const head = `
      <header class="page-head">
        <div class="stepper">
          <a class="step" href="#/day/${addDays(date, -1)}" aria-label="前一天">‹</a>
          <h1>${dt.getMonth() + 1}月${dt.getDate()}日</h1>
          <a class="step" href="#/day/${addDays(date, 1)}" aria-label="后一天">›</a>
        </div>
        <p class="sub">${yearPart}${wdName(date)}${rel ? `，${rel}` : ''}${date !== t0 ? `　<a href="#/day">回到今天</a>` : ''}</p>
      </header>`;

    if (!d) {
      return head + `
        <div class="empty">
          <p>这一天没有打卡记录。</p>
          <button class="btn" data-act="create-day" data-date="${date}">按固定事项补记这一天</button>
        </div>`;
    }

    const total = d.tasks.length;
    const done = d.tasks.filter(t => t.done).length;
    const plan = d.tasks.reduce((s, t) => s + t.minutes, 0);
    const donePlan = d.tasks.filter(t => t.done).reduce((s, t) => s + t.minutes, 0);
    const complete = total > 0 && done === total;
    // 印文右起竖读：日課 / 已畢
    const seal = complete
      ? `<div class="seal${stampAnim ? ' stamp' : ''}" role="img" aria-label="全部完成"><span>已</span><span>日</span><span>畢</span><span>課</span></div>`
      : `<div class="seal ghost" aria-hidden="true">${done}/${total}</div>`;

    return head + `
      <section class="sheet">
        <div class="sheet-head">
          <div>
            <p class="progress"><strong>${done}</strong> / ${total} 项完成</p>
            <p class="muted small">计划 ${fmtMin(plan)}，已完成 ${fmtMin(donePlan)}</p>
          </div>
          ${seal}
        </div>
        ${total ? `<ul class="tasks">${d.tasks.map(taskRow).join('')}</ul>`
                : `<p class="empty-row">这一天没有安排事项。可以在下面添加，或到「固定事项」里设定每周安排。</p>`}
        <form class="add-task" data-act="add-task" autocomplete="off">
          <input class="field" name="task" placeholder="添加一项临时事项" maxlength="60" required aria-label="事项名称">
          <label class="min-field"><input class="field" name="minutes" type="number" inputmode="numeric" min="0" max="600" step="5" value="20" aria-label="计划分钟"><span>分</span></label>
          <button class="btn">添加</button>
        </form>
      </section>

      <section class="note">
        <h2>Note</h2>
        <p class="muted small">超时了吗？哪项没完成，为什么？周报会读这里的内容。</p>
        <div class="chips">${TAGS.map(tag => `<button type="button" class="chip" data-act="tag" data-tag="${tag}" aria-pressed="${(d.tags || []).includes(tag)}">${tag}</button>`).join('')}</div>
        <textarea class="notepad" data-act="note" rows="5" aria-label="Note" placeholder="例如：Statistics 卡在回归那一节，多花了 20 分钟；晚上临时开会，Piano 没练。">${esc(d.note)}</textarea>
        <p class="muted small saved" id="noteSaved" aria-live="polite"></p>
      </section>`;
  }

  function taskRow(t) {
    const link = t.tid ? safeLink(tplFind(t.tid)?.link) : '';
    const over = isOver(t);
    return `
      <li class="task${t.done ? ' done' : ''}${anim === t.id ? ' anim' : ''}">
        <button class="del" data-act="del-task" data-id="${t.id}" aria-label="从这一天移除 ${esc(t.name)}" title="从这一天移除">×</button>
        <span class="task-name"><span class="tn">${esc(t.name)}</span>${t.tid ? '' : '<span class="adhoc">临时</span>'}${link ? `<a class="open" href="${esc(link)}" target="_blank" rel="noopener">打开</a>` : ''}</span>
        <span class="plan" title="计划">${hm(t.minutes)}</span>
        <label class="actual${over ? ' over' : ''}" title="${over ? '超出计划' : '实际用时（可选）'}">
          <input type="number" inputmode="numeric" min="0" max="900" step="5" data-act="actual" data-id="${t.id}" value="${t.actual ?? ''}" placeholder="实际" aria-label="${esc(t.name)} 实际用时（分钟）"><span>分</span>
        </label>
        <button class="check" data-act="toggle" data-id="${t.id}" role="checkbox" aria-checked="${!!t.done}" aria-label="${esc(t.name)}">
          <span class="box"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </button>
      </li>`;
  }

  function viewWeek({ start }) {
    const t0 = todayStr();
    const dates = weekDates(start);
    const isThisWeek = start === weekStart(t0);
    const rows = new Map();
    for (const t of state.template.tasks) rows.set(t.id, { name: t.name, cells: {}, done: 0, n: 0 });
    for (const date of dates) {
      const d = state.days[date];
      if (!d || date > t0) continue;
      for (const t of d.tasks) {
        const k = t.tid || 'n:' + t.name;
        if (!rows.has(k)) rows.set(k, { name: t.name, cells: {}, done: 0, n: 0 });
        const r = rows.get(k);
        r.cells[date] = t.done ? 'done' : 'miss';
        r.n++; if (t.done) r.done++;
      }
    }
    const a = aggregate(dates);
    const colClass = date => (date <= t0 && !state.days[date] ? 'unrec' : '');
    const cell = (r, date) => {
      const c = r.cells[date];
      const inner = c === 'done' ? '<span class="dot done" title="完成"></span>' : c === 'miss' ? '<span class="dot miss" title="未完成"></span>' : '';
      return `<td class="${colClass(date)}">${inner}</td>`;
    };
    const visibleRows = [...rows.values()].filter(r => r.n > 0 || state.template.tasks.some(t => t.name === r.name && t.days.length));
    const footer = dates.map(date => {
      const dr = a.dayRates.find(x => x.date === date);
      return `<td class="${colClass(date)}">${dr && dr.n ? pct(dr.done, dr.n) + '%' : ''}</td>`;
    }).join('');
    const T = a.totals;
    const notes = a.days.filter(d => (d.note || '').trim() || (d.tags || []).length);

    return `
      <header class="page-head">
        <div class="stepper">
          <a class="step" href="#/week/${addDays(start, -7)}" aria-label="上一周">‹</a>
          <h1>${isThisWeek ? '本周' : rangeLabel(start)}</h1>
          <a class="step" href="#/week/${addDays(start, 7)}" aria-label="下一周">›</a>
        </div>
        <p class="sub">${isThisWeek ? rangeLabel(start) : `<a href="#/week">回到本周</a>`}</p>
      </header>
      <p class="lead">${a.days.length
        ? `记录了 ${a.days.length} 天，完成 ${T.done} / ${T.items} 项（${pct(T.done, T.items)}%），已完成的计划时长 ${fmtMin(T.donePlan)}。`
        : '这一周还没有打卡记录。'}</p>
      <div class="scroll">
        <table class="grid">
          <thead><tr><th>事项</th>${dates.map(date => `<th class="${date === t0 ? 'is-today' : ''}"><a href="#/day/${date}">周${WD[parseYmd(date).getDay()]}<span>${parseYmd(date).getDate()}</span></a></th>`).join('')}<th>完成率</th></tr></thead>
          <tbody>${visibleRows.map(r => `<tr><td>${esc(r.name)}</td>${dates.map(date => cell(r, date)).join('')}<td class="rate">${r.n ? pct(r.done, r.n) + '%' : '—'}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>当天</td>${footer}<td class="rate">${T.items ? pct(T.done, T.items) + '%' : '—'}</td></tr></tfoot>
        </table>
      </div>
      <p class="legend"><span><i class="dot done"></i>完成</span><span><i class="dot miss"></i>未完成</span><span><i class="swatch unrec"></i>没有记录</span></p>
      <p><a class="btn" href="#/report/${start}">看这一周的周报</a></p>
      <h2>这周的 note</h2>
      ${notes.length ? `<ul class="notes">${notes.map(noteItem).join('')}</ul>` : '<p class="muted">这一周还没有写 note。</p>'}
      ${a.days.length ? exportButtons('week', start) : ''}`;
  }

  function noteItem(d) {
    return `<li><a href="#/day/${d.date}">${mdLabel(d.date)} ${wdName(d.date)}</a>${(d.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}${(d.note || '').trim() ? `<p>${esc(d.note).replace(/\n/g, '<br>')}</p>` : ''}</li>`;
  }

  function viewMonth({ ym }) {
    const t0 = todayStr();
    const [y, m] = ym.split('-').map(Number);
    const first = ymd(new Date(y, m - 1, 1));
    const last = ymd(new Date(y, m, 0));
    const gridStart = weekStart(first);
    const cells = [];
    for (let d = gridStart; d <= last || cells.length % 7; d = addDays(d, 1)) cells.push(d);
    const monthDates = cells.filter(d => d.slice(0, 7) === ym);
    const a = aggregate(monthDates);

    const cellHtml = date => {
      const rec = date <= t0 ? state.days[date] : null;
      let body = '';
      if (rec && rec.tasks.length) {
        const n = rec.tasks.length, dn = rec.tasks.filter(t => t.done).length;
        body = dn === n
          ? '<span class="mini-seal" aria-label="全部完成">畢</span>'
          : `<span class="mfrac">${dn}/${n}</span><span class="mbar"><i style="width:${pct(dn, n)}%"></i></span>`;
      }
      const hasNote = rec && ((rec.note || '').trim() || (rec.tags || []).length);
      const cls = ['mcell', date.slice(0, 7) !== ym ? 'out' : '', date === t0 ? 'today' : ''].join(' ');
      return `<a class="${cls}" href="#/day/${date}" aria-label="${mdLabel(date)}"><span class="mnum">${parseYmd(date).getDate()}</span>${body}${hasNote ? '<span class="notedot" title="有 note"></span>' : ''}</a>`;
    };

    let streak = 0, best = 0;
    for (const date of monthDates) {
      if (date > t0) break;
      const dr = a.dayRates.find(x => x.date === date);
      if (dr && dr.full) { streak++; best = Math.max(best, streak); } else streak = 0;
    }
    const full = a.dayRates.filter(x => x.full).length;
    const T = a.totals;
    const isThisMonth = ym === t0.slice(0, 7);
    const monthNotes = a.days.filter(d => (d.note || '').trim() || (d.tags || []).length);

    return `
      <header class="page-head">
        <div class="stepper">
          <a class="step" href="#/month/${monthAdd(ym, -1)}" aria-label="上个月">‹</a>
          <h1>${m}月</h1>
          <a class="step" href="#/month/${monthAdd(ym, 1)}" aria-label="下个月">›</a>
        </div>
        <p class="sub">${y}年${isThisMonth ? '' : `　<a href="#/month">回到本月</a>`}</p>
      </header>
      <div class="month">
        ${WD_ORDER.map(w => `<div class="mh">${WD[w]}</div>`).join('')}
        ${cells.map(cellHtml).join('')}
      </div>
      <p class="lead" style="margin-top:20px">${a.days.length
        ? `这个月记录了 ${a.days.length} 天，完成 ${T.done} / ${T.items} 项（${pct(T.done, T.items)}%）。全部完成的有 ${full} 天${best > 1 ? `，最长连续 ${best} 天` : ''}。`
        : '这个月还没有打卡记录。'}</p>
      ${a.tasks.length ? `<h2>各项完成率</h2><ul class="rates">${a.tasks.map(s => `<li><span>${esc(s.name)}</span><span class="bar"><i style="width:${pct(s.done, s.n)}%"></i></span><span class="n">${pct(s.done, s.n)}%</span></li>`).join('')}</ul>` : ''}
      ${a.days.length ? `<h2>这个月的 note</h2>${monthNotes.length ? `<ul class="notes">${monthNotes.map(noteItem).join('')}</ul>` : '<p class="muted">这个月还没有写 note。</p>'}${exportButtons('month', ym)}` : ''}`;
  }

  function viewReport({ start }) {
    const t0 = todayStr();
    const end = addDays(start, 6);
    const a = aggregate(weekDates(start));
    const isPastWeek = end < t0;
    const head = `
      <header class="page-head">
        <div class="stepper">
          <a class="step" href="#/report/${addDays(start, -7)}" aria-label="上一周">‹</a>
          <h1>周报</h1>
          <a class="step" href="#/report/${addDays(start, 7)}" aria-label="下一周">›</a>
        </div>
        <p class="sub">${rangeLabel(start)}${!isPastWeek && start <= t0 ? '，本周还在进行中' : ''}</p>
      </header>`;
    if (!a.days.length) {
      return head + `<div class="empty"><p>这一周没有打卡记录。周报会根据每天的勾选、实际用时和 note 生成。</p><a class="btn" href="#/day">去打卡</a></div>`;
    }
    const T = a.totals;
    const tags = Object.entries(a.tagCount).sort((x, y) => y[1] - x[1]);
    const notes = a.days.filter(d => (d.note || '').trim() || (d.tags || []).length);

    return head + `
      <p class="lead">记录了 ${a.days.length} 天，完成 ${T.done} / ${T.items} 项（${pct(T.done, T.items)}%）。计划总时长 ${fmtMin(T.plan)}，其中已完成的部分 ${fmtMin(T.donePlan)}。${T.actualN ? `填写了实际用时的 ${T.actualN} 项，共用时 ${fmtMin(T.actual)}。` : ''}</p>

      <h2>各项情况</h2>
      <div class="scroll">
        <table class="grid stats">
          <thead><tr><th>事项</th><th>完成</th><th>计划</th><th>平均实际</th><th>超时</th></tr></thead>
          <tbody>${a.tasks.map(s => `<tr><td>${esc(s.name)}</td><td>${s.done}/${s.n}</td><td>${Math.round(s.planSum / s.n)} 分</td><td>${s.actualN ? Math.round(s.actualSum / s.actualN) + ' 分' : '—'}</td><td class="${s.over ? 'warn' : ''}">${s.over ? s.over + ' 次' : '—'}</td></tr>`).join('')}</tbody>
        </table>
      </div>

      <h2>记录里的原因</h2>
      ${tags.length ? `<div class="chips">${tags.map(([k, v]) => `<span class="chip on">${esc(k)} ×${v}</span>`).join('')}</div>` : ''}
      ${notes.length ? `<ul class="notes">${notes.map(noteItem).join('')}</ul>` : '<p class="muted">这一周没有写 note。下次没完成或超时的时候，写一句原因就够了。</p>'}

      <h2>调整建议</h2>
      <ul class="sug">${suggestions(a, { isPastWeek }).map(s => `<li>${esc(s)}</li>`).join('')}</ul>

      <h2>导出</h2>
      <p class="muted small">把这一周的完成情况、实际用时和所有 note 整理成文字，可以直接贴给 AI 分析。</p>
      ${exportButtons('week', start)}`;
  }

  function wdTotalsHtml() {
    return WD_ORDER.map(w => {
      const m = state.template.tasks.filter(t => t.days.includes(w)).reduce((s, t) => s + t.minutes, 0);
      return `<span>周${WD[w]} <b>${hm(m)}</b></span>`;
    }).join('');
  }

  function viewSettings() {
    const list = state.template.tasks;
    const rows = list.map((t, i) => `
      <li class="tpl">
        <div class="tpl-main">
          <input class="field" data-act="tpl-name" data-tid="${t.id}" value="${esc(t.name)}" maxlength="60" aria-label="事项名称">
          <label class="min-field"><input class="field" type="number" inputmode="numeric" min="0" max="600" step="5" data-act="tpl-min" data-tid="${t.id}" value="${t.minutes}" aria-label="${esc(t.name)} 计划分钟"><span>分</span></label>
          <div class="tpl-tools">
            <button class="icon" data-act="tpl-move" data-dir="-1" data-tid="${t.id}" aria-label="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon" data-act="tpl-move" data-dir="1" data-tid="${t.id}" aria-label="下移" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon danger" data-act="tpl-del" data-tid="${t.id}" aria-label="删除 ${esc(t.name)}">×</button>
          </div>
        </div>
        <div class="tpl-sub">
          <div class="wds" role="group" aria-label="每周哪几天">${WD_ORDER.map(w => `<button type="button" class="wd" data-act="tpl-wd" data-tid="${t.id}" data-wd="${w}" aria-pressed="${t.days.includes(w)}" aria-label="周${WD[w]}">${WD[w]}</button>`).join('')}</div>
          <input class="field link" data-act="tpl-link" data-tid="${t.id}" value="${esc(t.link || '')}" placeholder="相关链接（可选），打卡页会显示“打开”" inputmode="url" aria-label="${esc(t.name)} 相关链接">
        </div>
      </li>`).join('');

    return `
      <header class="page-head">
        <h1>固定事项</h1>
        <p class="sub">每周的固定安排。修改会立刻用到今天和之后的日子，过去的记录保持不变。</p>
      </header>
      <ul class="tpls">${rows}</ul>
      <button class="btn" data-act="tpl-add">添加固定事项</button>
      <p class="wd-totals" id="wdTotals">${wdTotalsHtml()}</p>

      <section class="settings-block">
        <h2>同步</h2>
        <p class="muted small">把 Google 表格里 Apps Script 部署出来的网址（以 /exec 结尾）和你在脚本属性里设的口令填在这里。每台设备填一次，记录就会同步到同一张表格。</p>
        <div class="sync-form">
          <input class="field" id="urlInput" type="url" value="${esc(settings.url)}" placeholder="https://script.google.com/macros/s/…/exec" aria-label="Apps Script 网址" autocomplete="off">
          <div class="row">
            <input class="field" id="tokenInput" type="password" value="${esc(settings.token)}" placeholder="口令" autocomplete="current-password" aria-label="口令">
            <button class="btn primary" data-act="save-sync">保存并同步</button>
            ${syncOn() ? '<button class="btn" data-act="clear-sync">停止同步</button>' : ''}
          </div>
        </div>
      </section>

      <section class="settings-block">
        <h2>备份</h2>
        <p class="muted small">没有开启同步时，记录只保存在这个浏览器里。定期导出一份更安全。导入会和现有记录合并。</p>
        <div class="row">
          <button class="btn" data-act="export">导出备份</button>
          <button class="btn" data-act="import">导入备份</button>
          <input type="file" id="importFile" accept="application/json,.json" hidden>
        </div>
      </section>`;
  }

  /* ---------------- events ---------------- */
  const dayRec = () => (current.view === 'day' ? state.days[current.date] : null);

  main.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || !main.contains(el) || el.tagName === 'FORM' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
    const act = el.dataset.act;
    const d = dayRec();

    switch (act) {
      case 'toggle': {
        const t = d?.tasks.find(x => x.id === el.dataset.id);
        if (!t) return;
        const wasFull = d.tasks.every(x => x.done);
        t.done = !t.done;
        if (t.done) anim = t.id;
        stampAnim = !wasFull && d.tasks.every(x => x.done);
        touch(d); save(); render();
        main.querySelector(`[data-act="toggle"][data-id="${t.id}"]`)?.focus({ preventScroll: true });
        break;
      }
      case 'del-task': {
        const i = d?.tasks.findIndex(x => x.id === el.dataset.id) ?? -1;
        if (i < 0) return;
        const [t] = d.tasks.splice(i, 1);
        if (t.tid) (d.skipped ||= []).push(t.tid);
        touch(d); save(); render();
        toast(`已从这一天移除「${t.name}」`);
        break;
      }
      case 'tag': {
        if (!d) return;
        d.tags ||= [];
        const tag = el.dataset.tag;
        const on = d.tags.includes(tag);
        d.tags = on ? d.tags.filter(x => x !== tag) : [...d.tags, tag];
        el.setAttribute('aria-pressed', String(!on));
        touch(d); save();
        break;
      }
      case 'create-day': {
        const date = el.dataset.date;
        state.days[date] = newDay(date, Date.now());
        save(); render();
        break;
      }
      case 'tpl-wd': {
        const t = tplFind(el.dataset.tid); if (!t) return;
        const w = Number(el.dataset.wd);
        t.days = t.days.includes(w) ? t.days.filter(x => x !== w) : [...t.days, w];
        el.setAttribute('aria-pressed', String(t.days.includes(w)));
        tplChanged(); updateWdTotals();
        break;
      }
      case 'tpl-move': {
        const list = state.template.tasks;
        const i = list.findIndex(t => t.id === el.dataset.tid);
        const j = i + Number(el.dataset.dir);
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        tplChanged(); render();
        main.querySelectorAll(`[data-act="tpl-move"][data-tid="${list[j].id}"]`)[j < i ? 0 : 1]?.focus();
        break;
      }
      case 'tpl-del': {
        const t = tplFind(el.dataset.tid); if (!t) return;
        if (!confirm(`删除「${t.name}」？今天及之后的安排里会移除它（已完成的保留），过去的记录不变。`)) return;
        state.template.tasks = state.template.tasks.filter(x => x.id !== t.id);
        tplChanged(); render();
        toast(`已删除「${t.name}」`);
        break;
      }
      case 'tpl-add': {
        const t = { id: 't-' + uid(), name: '新事项', minutes: 20, days: [...ALL_DAYS], link: '' };
        state.template.tasks.push(t);
        tplChanged(); render();
        const input = main.querySelector(`[data-act="tpl-name"][data-tid="${t.id}"]`);
        input?.focus(); input?.select();
        break;
      }
      case 'save-sync': {
        const url = document.getElementById('urlInput').value.trim();
        const token = document.getElementById('tokenInput').value.trim();
        if (!url || !token) { toast('网址和口令都要填'); return; }
        if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
          toast(/\/dev$/.test(url) ? '这是测试网址（/dev），请用「部署」生成的 /exec 网址' : '网址应以 https://script.google.com/ 开头、以 /exec 结尾');
          return;
        }
        settings.url = url; settings.token = token; saveSettings();
        syncNow(true).then(ok => { if (ok) { toast('已同步'); render(); } });
        break;
      }
      case 'clear-sync': {
        settings.url = ''; settings.token = ''; settings.lastSync = 0; saveSettings();
        setSync('记录保存在这台设备'); render();
        toast('已停止同步，记录继续保存在这台设备');
        break;
      }
      case 'export-copy': { const s = exportScope(el); copyText(exportText(s.dates, s.title)); break; }
      case 'export-md': { const s = exportScope(el); downloadFile(s.file, exportText(s.dates, s.title), 'text/markdown;charset=utf-8'); break; }
      case 'export': exportData(); break;
      case 'import': document.getElementById('importFile')?.click(); break;
    }
  });

  main.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'importFile') { importData(el.files?.[0]); el.value = ''; return; }
    const act = el.dataset.act;
    if (!act) return;
    if (act === 'actual') {
      const d = dayRec();
      const t = d?.tasks.find(x => x.id === el.dataset.id);
      if (!t) return;
      const v = el.value.trim();
      t.actual = v === '' || !Number.isFinite(Number(v)) ? null : Math.min(900, Math.max(0, Math.round(Number(v))));
      el.value = t.actual ?? '';
      el.closest('.actual').classList.toggle('over', isOver(t));
      touch(d); save();
      return;
    }
    if (act.startsWith('tpl-')) {
      const t = tplFind(el.dataset.tid);
      if (!t) return;
      if (act === 'tpl-name') { const v = el.value.trim(); if (!v) { el.value = t.name; return; } t.name = v; }
      if (act === 'tpl-min') { t.minutes = clampMin(el.value); el.value = t.minutes; }
      if (act === 'tpl-link') { const v = el.value.trim(); t.link = !v || /^https?:\/\//i.test(v) ? v : 'https://' + v; el.value = t.link; }
      tplChanged(); updateWdTotals();
    }
  });

  let noteTimer = null;
  main.addEventListener('input', e => {
    if (e.target.dataset.act !== 'note') return;
    const d = dayRec(); if (!d) return;
    d.note = e.target.value;
    touch(d); persist();
    const s = document.getElementById('noteSaved');
    if (s) s.textContent = '';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      scheduleSync();
      const s2 = document.getElementById('noteSaved');
      if (s2) s2.textContent = '已保存';
    }, 700);
  });

  main.addEventListener('submit', e => {
    const f = e.target;
    if (f.dataset.act !== 'add-task') return;
    e.preventDefault();
    const d = dayRec(); if (!d) return;
    const name = f.querySelector('[name=task]').value.trim();
    if (!name) return;
    const minutes = clampMin(f.querySelector('[name=minutes]').value);
    d.tasks.push({ id: uid(), tid: null, name, minutes, done: false, actual: null });
    touch(d); save(); render();
    main.querySelector('[name=task]')?.focus();
  });

  function updateWdTotals() { const el = document.getElementById('wdTotals'); if (el) el.innerHTML = wdTotalsHtml(); }

  /* ---------------- sync (Google Apps Script) ---------------- */
  function merge(a, b) {
    const out = {
      version: 1,
      template: (b.template.updatedAt || 0) > (a.template.updatedAt || 0) ? b.template : a.template,
      days: { ...a.days },
    };
    for (const [k, v] of Object.entries(b.days)) {
      const l = out.days[k];
      if (!l || (v.updatedAt || 0) > (l.updatedAt || 0)) out.days[k] = v;
    }
    return out;
  }

  // 只上传动过的日子；自动生成、还没碰过的（updatedAt=0）不占表格行
  const touchedDays = () => Object.fromEntries(Object.entries(state.days).filter(([, d]) => d.updatedAt > 0));

  function setSync(text, bad) { syncEl.textContent = text; syncEl.classList.toggle('bad', !!bad); }

  let syncTimer = null, syncing = false, syncAgain = false;
  function scheduleSync() {
    if (!syncOn()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), 1500);
  }
  // 一次请求完成：把本地记录发给脚本，脚本按“谁改得晚以谁为准”合并进表格，再把合并结果返回
  async function syncNow(loud) {
    if (!syncOn()) return false;
    if (syncing) { syncAgain = true; return false; }
    syncing = true;
    setSync('同步中…');
    let ok = false;
    try {
      const r = await fetch(settings.url, {
        method: 'POST',
        // text/plain 不触发预检请求，Apps Script 才能正常响应
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: settings.token, state: { template: state.template, days: touchedDays() } }),
      });
      let j;
      try { j = await r.json(); } catch { throw new Error('脚本没有返回数据，检查网址和部署权限（有权访问的用户：任何人）'); }
      if (j.error) throw new Error(j.error);
      const before = state.template.updatedAt;
      state = merge(state, normalize(j.state));
      if (state.template.updatedAt !== before) applyTemplate();
      persist();
      settings.lastSync = Date.now(); saveSettings();
      setSync(`已同步 ${fmtTime(settings.lastSync).split(' ')[1]}`);
      ok = true;
    } catch (err) {
      const msg = err instanceof TypeError ? '连不上 Google（网络或代理问题）' : err.message;
      setSync('同步失败：' + msg, true);
      if (loud) toast('同步失败：' + msg);
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; scheduleSync(); }
    }
    return ok;
  }

  /* ---------------- backup ---------------- */
  function exportData() {
    downloadFile(`rike-backup-${todayStr()}.json`, JSON.stringify({ app: 'rike', exportedAt: new Date().toISOString(), state }, null, 2), 'application/json');
  }
  async function importData(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = normalize(data.state || data);
      const before = state.template.updatedAt;
      state = merge(state, incoming);
      if (state.template.updatedAt !== before) applyTemplate();
      save(); render();
      toast('已导入并合并');
    } catch {
      toast('文件格式不对，请选择从这里导出的 JSON 备份');
    }
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  /* ---------------- boot ---------------- */
  setSync(syncOn() ? (settings.lastSync ? `上次同步 ${fmtTime(settings.lastSync)}` : '等待同步') : '记录保存在这台设备');
  render();
  window.addEventListener('hashchange', () => { render(); main.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  if (syncOn()) syncNow().then(ok => ok && softRender());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (syncOn()) syncNow().then(() => softRender()); else softRender();
  });
})();
