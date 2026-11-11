// 重生成拼接 v0.1.0
// 1. 点「重新生成」时，把被删掉的旧回复塞回新回复的 swipes 里，左右翻就能看到
// 2. 剪刀按钮 / 悬浮球打开面板：按段落挑选拼接，也能直接改正文

const MODULE = 'regenSplice';

const DEFAULTS = {
    enabled: true,     // 是否在重新生成时保留旧版本
    maxKeep: 20,       // 每条消息最多保留的版本数，超出会删掉最旧的（最小 2）
    ball: true,        // 是否显示悬浮球
    ballSize: 46,      // 悬浮球直径（像素）
    ballPos: null,     // 悬浮球位置，拖动后自动记录，不用手动改
};

const ctx = () => SillyTavern.getContext();

function settings() {
    const es = ctx().extensionSettings;
    es[MODULE] = Object.assign({}, DEFAULTS, es[MODULE] || {});
    return es[MODULE];
}

// ───────────── 重新生成保留 ─────────────

let pending = null; // 等待合并的旧版本 { index, swipes, info, msg }

function onGenStarted(type, _opts, dryRun) {
    if (dryRun) return;
    pending = null;
    if (type !== 'regenerate' || !settings().enabled) return;

    const chat = ctx().chat;
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) return;

    const sid = Number.isInteger(last.swipe_id) ? last.swipe_id : 0;
    const swipes = Array.isArray(last.swipes) && last.swipes.length ? [...last.swipes] : [last.mes];
    swipes[sid] = last.mes; // 当前版本以显示内容为准（可能手动编辑过）

    const info = Array.isArray(last.swipe_info) ? structuredClone(last.swipe_info) : [];
    while (info.length < swipes.length) info.push({ send_date: last.send_date, extra: {} });

    pending = { index: chat.length - 1, swipes, info, msg: structuredClone(last) };
}

async function onCharRendered(messageId) {
    if (!pending) return;
    const id = Number(messageId);
    if (id !== pending.index) return;

    const c = ctx();
    const msg = c.chat[id];
    if (!msg || msg.is_user) return;

    const p = pending;
    pending = null;

    const newText = msg.mes;
    const newInfo = msg.swipe_info?.[msg.swipe_id ?? 0] ?? { send_date: msg.send_date, extra: structuredClone(msg.extra || {}) };

    // 旧版本在前，新版本放最后；去重
    const swipes = [];
    const info = [];
    p.swipes.forEach((t, i) => {
        if (t !== newText && !swipes.includes(t)) {
            swipes.push(t);
            info.push(p.info[i]);
        }
    });
    swipes.push(newText);
    info.push(newInfo);

    const max = Math.max(2, parseInt(settings().maxKeep) || DEFAULTS.maxKeep);
    while (swipes.length > max) {
        swipes.shift();
        info.shift();
    }

    msg.swipes = swipes;
    msg.swipe_info = info;
    msg.swipe_id = swipes.length - 1;

    refreshSwipeUI(id, msg);
    await c.saveChat();
}

// 生成被中断且没有产出新消息时，把旧回复恢复回来
function onGenEnded() {
    if (!pending) return;
    setTimeout(async () => {
        if (!pending) return;
        const c = ctx();
        if (c.chat.length !== pending.index) return; // 已有新消息，交给渲染事件处理
        const p = pending;
        pending = null;
        c.chat.push(p.msg);
        c.addOneMessage(p.msg);
        await c.saveChat();
        toastr.info('生成未完成，已恢复上一版回复');
    }, 500); // 等待渲染的延迟（毫秒），恢复误触发可调大
}

function refreshSwipeUI(id, msg) {
    const $mes = $(`#chat .mes[mesid="${id}"]`);
    $mes.find('.swipes-counter').text(`${msg.swipe_id + 1}/${msg.swipes.length}`);
    if (msg.swipes.length > 1) {
        $mes.find('.swipe_left').css('display', 'flex');
        $mes.find('.swipe_right').css('display', 'flex');
    }
}

// ───────────── 拼接面板 ─────────────
// 「挑选」：各版本按段落排成卡片，点一下选中，按点的顺序编号
// 「成稿」：选中的段落按顺序排好，点文字直接改，可上下移、删除、新增

const BTN_HTML = '<div title="版本拼接" class="mes_button regen_splice_btn fa-solid fa-scissors"></div>';

function injectButtons() {
    const $tpl = $('#message_template .mes_buttons .extraMesButtons');
    if (!$tpl.find('.regen_splice_btn').length) $tpl.prepend(BTN_HTML);
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.regen_splice_btn').length) $(this).prepend(BTN_HTML);
    });
}

const state = {
    id: -1,
    versions: [],   // [[{text, sep}, ...], ...] 每个版本拆成段落
    cur: 0,         // 当前显示的版本
    items: [],      // 成稿 [{key, from, text, sep}]
    tab: 'pick',
    collapsed: new Set(),
    editing: -1,
    newCount: 0,
};

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 按换行拆段，保留原本的换行方式（单换行 / 空一行）
function splitParas(text) {
    const parts = String(text).split(/(\n+)/);
    const out = [];
    for (let i = 0; i < parts.length; i += 2) {
        if (!parts[i].trim()) continue;
        out.push({ text: parts[i], sep: parts[i + 1] || '\n' });
    }
    return out;
}

function joinItems() {
    return state.items.map((it, i) => (i < state.items.length - 1 ? it.text + it.sep : it.text)).join('');
}

function openPanel(id) {
    const msg = ctx().chat[id];
    if (!msg) return;

    const raw = Array.isArray(msg.swipes) && msg.swipes.length ? [...msg.swipes] : [msg.mes];
    const cur = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    raw[cur] = msg.mes;

    const versions = raw.map(splitParas);
    // 默认成稿 = 当前版本全部段落，所以不拼接也能直接改正文
    const items = versions[cur].map((p, i) => ({ key: `${cur}-${i}`, from: cur, text: p.text, sep: p.sep }));

    Object.assign(state, {
        id, versions, cur, items,
        tab: versions.length > 1 ? 'pick' : 'draft',
        collapsed: new Set(),
        editing: -1,
        newCount: 0,
    });

    $('#rs_overlay').remove();
    $('body').append(`
<div id="rs_overlay">
  <div id="rs_panel">
    <div class="rs_head">
      <div class="rs_title">第 ${id} 楼</div>
      <div class="rs_seg">
        <div class="rs_seg_btn" data-tab="pick">挑选</div>
        <div class="rs_seg_btn" data-tab="draft">成稿</div>
      </div>
      <div class="rs_close fa-solid fa-xmark" title="关闭"></div>
    </div>
    <div class="rs_body"></div>
    <div class="rs_foot"></div>
  </div>
</div>`);
    render();
}

function render(keepScroll = true) {
    const $body = $('#rs_panel .rs_body');
    const top = $body.scrollTop();

    $('#rs_panel .rs_seg_btn').each(function () {
        const t = $(this).data('tab');
        $(this).toggleClass('rs_on', t === state.tab);
        if (t === 'draft') $(this).text(`成稿 ${state.items.length}`);
    });

    if (state.tab === 'pick') {
        $body.html(renderPick());
        $('#rs_panel .rs_foot').html(`
<div class="rs_foot_info">已选 ${state.items.length} 段</div>
<div class="menu_button rs_go_draft">看成稿</div>`);
    } else {
        $body.html(renderDraft());
        $('#rs_panel .rs_foot').html(`
<div class="menu_button rs_copy">复制</div>
<div class="menu_button rs_save rs_primary">写回正文</div>`);
    }

    if (keepScroll) $body.scrollTop(top);
}

function renderPick() {
    const order = new Map(state.items.map((it, i) => [it.key, i + 1]));
    return state.versions.map((paras, v) => {
        const picked = paras.filter((_, p) => order.has(`${v}-${p}`)).length;
        const folded = state.collapsed.has(v);
        const cards = folded ? '' : paras.map((para, p) => {
            const n = order.get(`${v}-${p}`);
            return `
<div class="rs_card ${n ? 'rs_sel' : ''}" data-key="${v}-${p}">
  <div class="rs_text">${escapeHtml(para.text)}</div>
  ${n ? `<div class="rs_badge">${n}</div>` : ''}
</div>`;
        }).join('');
        return `
<div class="rs_group">
  <div class="rs_group_head" data-v="${v}">
    <div class="rs_group_name">版本 ${v + 1}${v === state.cur ? '<span class="rs_tag">当前</span>' : ''}</div>
    <div class="rs_group_count">${picked}/${paras.length}</div>
    <div class="rs_group_all" data-v="${v}">${picked === paras.length ? '全不选' : '全选'}</div>
    <div class="fa-solid ${folded ? 'fa-chevron-down' : 'fa-chevron-up'} rs_group_fold"></div>
  </div>
  ${cards}
</div>`;
    }).join('');
}

function renderDraft() {
    if (!state.items.length) {
        return `<div class="rs_empty">还没有段落。去「挑选」里点几段，或者在下面新增一段。</div>
<div class="rs_add_para">+ 新增一段</div>`;
    }
    const cards = state.items.map((it, i) => {
        const from = it.from < 0 ? '新增' : `版本 ${it.from + 1}`;
        const body = i === state.editing
            ? `<textarea class="rs_edit" rows="1"></textarea>`
            : `<div class="rs_text rs_tap_edit">${escapeHtml(it.text) || '<span class="rs_placeholder">点这里输入</span>'}</div>`;
        return `
<div class="rs_card rs_draft ${i === state.editing ? 'rs_editing' : ''}" data-i="${i}">
  <div class="rs_meta">
    <span>${from}</span>
    <div class="rs_ops">
      <div class="fa-solid fa-arrow-up rs_up" title="上移"></div>
      <div class="fa-solid fa-arrow-down rs_down" title="下移"></div>
      <div class="fa-solid fa-trash-can rs_del" title="删除"></div>
    </div>
  </div>
  ${body}
</div>`;
    }).join('');
    return cards + '<div class="rs_add_para">+ 新增一段</div>';
}

function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
}

function startEdit(i) {
    commitEdit();
    state.editing = i;
    render();
    const ta = $('#rs_panel .rs_edit')[0];
    if (!ta) return;
    ta.value = state.items[i].text;
    autoGrow(ta);
    ta.focus();
}

function commitEdit() {
    if (state.editing < 0) return;
    const ta = $('#rs_panel .rs_edit')[0];
    if (ta && state.items[state.editing]) state.items[state.editing].text = ta.value;
    state.editing = -1;
}

function togglePick(key) {
    const idx = state.items.findIndex(it => it.key === key);
    if (idx >= 0) {
        state.items.splice(idx, 1);
    } else {
        const [v, p] = key.split('-').map(Number);
        const para = state.versions[v][p];
        state.items.push({ key, from: v, text: para.text, sep: para.sep });
    }
    render();
}

function toggleAll(v) {
    const paras = state.versions[v];
    const keys = paras.map((_, p) => `${v}-${p}`);
    const allPicked = keys.every(k => state.items.some(it => it.key === k));
    if (allPicked) {
        state.items = state.items.filter(it => !keys.includes(it.key));
    } else {
        keys.forEach((k, p) => {
            if (!state.items.some(it => it.key === k)) state.items.push({ key: k, from: v, text: paras[p].text, sep: paras[p].sep });
        });
    }
    render();
}

function moveItem(i, d) {
    commitEdit();
    const j = i + d;
    if (j < 0 || j >= state.items.length) return;
    [state.items[i], state.items[j]] = [state.items[j], state.items[i]];
    render();
}

function delItem(i) {
    commitEdit();
    state.items.splice(i, 1);
    render();
}

function addPara() {
    commitEdit();
    state.items.push({ key: `new-${state.newCount++}`, from: -1, text: '', sep: '\n' });
    startEdit(state.items.length - 1);
}

function closePanel() {
    $('#rs_overlay').remove();
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    toastr.success('已复制');
}

async function writeBack() {
    commitEdit();
    state.items = state.items.filter(it => it.text.trim());
    const text = joinItems();
    if (!text.trim()) {
        toastr.warning('成稿是空的');
        render();
        return;
    }
    const c = ctx();
    const msg = c.chat[state.id];
    if (!msg) return;

    if (!Array.isArray(msg.swipes) || !msg.swipes.length) {
        msg.swipes = [msg.mes];
        msg.swipe_id = 0;
    }
    if (!Array.isArray(msg.swipe_info)) msg.swipe_info = [];
    while (msg.swipe_info.length < msg.swipes.length) msg.swipe_info.push({ send_date: msg.send_date, extra: {} });

    msg.swipes[msg.swipe_id ?? 0] = msg.mes;
    msg.swipes.push(text);
    msg.swipe_info.push({ send_date: msg.send_date, gen_started: null, gen_finished: null, extra: { regen_splice: true } });
    msg.swipe_id = msg.swipes.length - 1;
    msg.mes = text;

    c.updateMessageBlock(state.id, msg);
    refreshSwipeUI(state.id, msg);
    await c.saveChat();

    closePanel();
    toastr.success('已写回正文，原版本可左右翻找回');
}

function bindPanelEvents() {
    $(document)
        .on('click', '.regen_splice_btn', function () {
            openPanel(Number($(this).closest('.mes').attr('mesid')));
        })
        .on('click', '#rs_overlay', function (e) {
            if (e.target === this) closePanel();
        })
        .on('click', '#rs_panel .rs_close', closePanel)
        .on('click', '#rs_panel .rs_seg_btn', function () {
            commitEdit();
            state.tab = $(this).data('tab');
            render(false);
            $('#rs_panel .rs_body').scrollTop(0);
        })
        .on('click', '#rs_panel .rs_go_draft', () => {
            state.tab = 'draft';
            render(false);
            $('#rs_panel .rs_body').scrollTop(0);
        })
        // 挑选
        .on('click', '#rs_panel .rs_card:not(.rs_draft)', function () { togglePick(String($(this).data('key'))); })
        .on('click', '#rs_panel .rs_group_all', function (e) {
            e.stopPropagation();
            toggleAll(Number($(this).data('v')));
        })
        .on('click', '#rs_panel .rs_group_head', function () {
            const v = Number($(this).data('v'));
            state.collapsed.has(v) ? state.collapsed.delete(v) : state.collapsed.add(v);
            render();
        })
        // 成稿
        .on('click', '#rs_panel .rs_tap_edit', function () { startEdit(Number($(this).closest('.rs_card').data('i'))); })
        .on('input', '#rs_panel .rs_edit', function () {
            autoGrow(this);
            if (state.items[state.editing]) state.items[state.editing].text = this.value;
        })
        .on('click', '#rs_panel .rs_up', function () { moveItem(Number($(this).closest('.rs_card').data('i')), -1); })
        .on('click', '#rs_panel .rs_down', function () { moveItem(Number($(this).closest('.rs_card').data('i')), 1); })
        .on('click', '#rs_panel .rs_del', function () { delItem(Number($(this).closest('.rs_card').data('i'))); })
        .on('click', '#rs_panel .rs_add_para', addPara)
        .on('click', '#rs_panel .rs_copy', () => {
            commitEdit();
            copyText(joinItems());
            render();
        })
        .on('click', '#rs_panel .rs_save', writeBack);
}

// ───────────── 悬浮球 ─────────────

const DRAG_THRESHOLD = 6; // 移动超过多少像素算拖动（否则算点击）

function lastAiIndex() {
    const chat = ctx().chat;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) return i;
    }
    return -1;
}

function clampBall(x, y) {
    const size = settings().ballSize;
    return {
        x: Math.min(Math.max(0, x), window.innerWidth - size),
        y: Math.min(Math.max(0, y), window.innerHeight - size),
    };
}

function placeBall(x, y) {
    const p = clampBall(x, y);
    $('#rs_ball').css({ left: p.x + 'px', top: p.y + 'px' });
    return p;
}

function renderBall() {
    $('#rs_ball').remove();
    const s = settings();
    if (!s.ball) return;

    const $b = $('<div id="rs_ball" class="fa-solid fa-scissors" title="版本拼接"></div>').appendTo('body');
    $b.css({ width: s.ballSize + 'px', height: s.ballSize + 'px', fontSize: Math.round(s.ballSize * 0.4) + 'px' });

    // 默认位置：右侧偏下
    const pos = s.ballPos || { x: window.innerWidth - s.ballSize - 12, y: window.innerHeight * 0.6 };
    placeBall(pos.x, pos.y);

    const el = $b[0];
    let drag = null;

    el.addEventListener('pointerdown', e => {
        drag = { sx: e.clientX, sy: e.clientY, l: el.offsetLeft, t: el.offsetTop, moved: false };
        el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) drag.moved = true;
        if (drag.moved) placeBall(drag.l + dx, drag.t + dy);
    });

    el.addEventListener('pointerup', () => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        if (moved) {
            settings().ballPos = { x: el.offsetLeft, y: el.offsetTop };
            ctx().saveSettingsDebounced();
            return;
        }
        const id = lastAiIndex();
        if (id < 0) {
            toastr.warning('当前聊天里还没有 AI 回复');
            return;
        }
        openPanel(id);
    });

    el.addEventListener('pointercancel', () => { drag = null; });
}

// ───────────── 设置面板 ─────────────

function renderSettings() {
    const s = settings();
    $('#extensions_settings2').append(`
<div class="regen-splice-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>重生成拼接</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="rs_enabled"> 重新生成时保留旧版本</label>
      <label>每条消息最多保留版本数<input type="number" id="rs_max" class="text_pole" min="2"></label>
      <label class="checkbox_label"><input type="checkbox" id="rs_ball_on"> 显示悬浮球</label>
      <label>悬浮球大小（像素）<input type="number" id="rs_ball_size" class="text_pole" min="30" max="80"></label>
    </div>
  </div>
</div>`);

    $('#rs_enabled').prop('checked', s.enabled).on('change', function () {
        settings().enabled = this.checked;
        ctx().saveSettingsDebounced();
    });
    $('#rs_max').val(s.maxKeep).on('input', function () {
        settings().maxKeep = Math.max(2, parseInt(this.value) || DEFAULTS.maxKeep);
        ctx().saveSettingsDebounced();
    });
    $('#rs_ball_on').prop('checked', s.ball).on('change', function () {
        settings().ball = this.checked;
        ctx().saveSettingsDebounced();
        renderBall();
    });
    $('#rs_ball_size').val(s.ballSize).on('change', function () {
        settings().ballSize = Math.min(80, Math.max(30, parseInt(this.value) || DEFAULTS.ballSize));
        ctx().saveSettingsDebounced();
        renderBall();
    });
}

// ───────────── 初始化 ─────────────

jQuery(() => {
    const c = ctx();
    const ev = c.eventTypes || c.event_types;

    renderSettings();
    injectButtons();
    bindPanelEvents();
    renderBall();
    window.addEventListener('resize', () => {
        const el = document.getElementById('rs_ball');
        if (el) placeBall(el.offsetLeft, el.offsetTop);
    });

    c.eventSource.on(ev.GENERATION_STARTED, onGenStarted);
    c.eventSource.on(ev.CHARACTER_MESSAGE_RENDERED, onCharRendered);
    c.eventSource.on(ev.GENERATION_ENDED, onGenEnded);
    c.eventSource.on(ev.GENERATION_STOPPED, onGenEnded);
    c.eventSource.on(ev.CHAT_CHANGED, () => {
        pending = null;
        injectButtons();
    });
});
