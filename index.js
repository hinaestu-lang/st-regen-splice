// 重生成拼接 v0.1.0
// 1. 点「重新生成」时，把被删掉的旧回复塞回新回复的 swipes 里，左右翻就能看到
// 2. 每条 AI 消息多一个剪刀按钮，打开面板在各版本间剪裁拼接，写回为新版本

const MODULE = 'regenSplice';

const DEFAULTS = {
    enabled: true,     // 是否在重新生成时保留旧版本
    maxKeep: 20,       // 每条消息最多保留的版本数，超出会删掉最旧的（最小 2）
    separator: '\\n\\n', // 片段之间的拼接分隔符，\n 表示换行，默认空一行
};

const ctx = () => SillyTavern.getContext();

function settings() {
    const es = ctx().extensionSettings;
    es[MODULE] = Object.assign({}, DEFAULTS, es[MODULE] || {});
    return es[MODULE];
}

const sepText = () => String(settings().separator).replace(/\\n/g, '\n');

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

const BTN_HTML = '<div title="版本拼接" class="mes_button regen_splice_btn fa-solid fa-scissors"></div>';

function injectButtons() {
    const $tpl = $('#message_template .mes_buttons .extraMesButtons');
    if (!$tpl.find('.regen_splice_btn').length) $tpl.prepend(BTN_HTML);
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.regen_splice_btn').length) $(this).prepend(BTN_HTML);
    });
}

const state = { id: -1, versions: [], view: 0, frags: [], dirty: false };

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function openPanel(id) {
    const msg = ctx().chat[id];
    if (!msg) return;

    const versions = Array.isArray(msg.swipes) && msg.swipes.length ? [...msg.swipes] : [msg.mes];
    const cur = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    versions[cur] = msg.mes;

    Object.assign(state, { id, versions, view: cur, frags: [], dirty: false });

    $('#rs_overlay').remove();
    $('body').append(`
<div id="rs_overlay">
  <div id="rs_panel">
    <div class="rs_head">
      <span>版本拼接：第 ${id} 楼</span>
      <div class="rs_close fa-solid fa-xmark" title="关闭"></div>
    </div>
    <div class="rs_tabs"></div>
    <textarea class="rs_source text_pole" readonly></textarea>
    <div class="rs_row">
      <div class="menu_button rs_add_sel">加入选中</div>
      <div class="menu_button rs_add_all">加入整段</div>
    </div>
    <div class="rs_label">拼接片段</div>
    <div class="rs_frags"></div>
    <div class="rs_label">结果（可直接修改）</div>
    <textarea class="rs_result text_pole"></textarea>
    <div class="rs_row">
      <div class="menu_button rs_copy">复制结果</div>
      <div class="menu_button rs_save">写回为新版本</div>
    </div>
  </div>
</div>`);

    renderTabs();
    renderFrags();
}

function renderTabs() {
    const html = state.versions.map((_, i) =>
        `<div class="menu_button rs_tab ${i === state.view ? 'rs_active' : ''}" data-i="${i}">版本 ${i + 1}</div>`).join('');
    $('#rs_panel .rs_tabs').html(html);
    $('#rs_panel .rs_source').val(state.versions[state.view]);
}

function renderFrags() {
    const $box = $('#rs_panel .rs_frags');
    if (!state.frags.length) {
        $box.html('<div class="rs_empty">在上方选中文字后点「加入选中」</div>');
    } else {
        $box.html(state.frags.map((f, i) => `
<div class="rs_frag" data-i="${i}">
  <div class="rs_frag_src">版本 ${f.from + 1}</div>
  <div class="rs_frag_text">${escapeHtml(f.text)}</div>
  <div class="rs_frag_ops">
    <div class="fa-solid fa-arrow-up rs_up" title="上移"></div>
    <div class="fa-solid fa-arrow-down rs_down" title="下移"></div>
    <div class="fa-solid fa-trash-can rs_del" title="删除"></div>
  </div>
</div>`).join(''));
    }
}

function rebuildResult() {
    if (state.dirty && !confirm('结果已手动修改，按片段重新生成会覆盖修改，继续吗？')) return false;
    $('#rs_panel .rs_result').val(state.frags.map(f => f.text).join(sepText()));
    state.dirty = false;
    return true;
}

function addFrag(text) {
    text = text.trim();
    if (!text) {
        toastr.warning('没有选中文字');
        return;
    }
    state.frags.push({ from: state.view, text });
    if (!rebuildResult()) state.frags.pop();
    renderFrags();
}

function moveFrag(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.frags.length) return;
    const backup = [...state.frags];
    [state.frags[i], state.frags[j]] = [state.frags[j], state.frags[i]];
    if (!rebuildResult()) state.frags = backup;
    renderFrags();
}

function delFrag(i) {
    const backup = [...state.frags];
    state.frags.splice(i, 1);
    if (!rebuildResult()) state.frags = backup;
    renderFrags();
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
    const text = String($('#rs_panel .rs_result').val());
    if (!text.trim()) {
        toastr.warning('结果是空的');
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

    $('#rs_overlay').remove();
    toastr.success('已写回为新版本');
}

function bindPanelEvents() {
    $(document)
        .on('click', '.regen_splice_btn', function () {
            openPanel(Number($(this).closest('.mes').attr('mesid')));
        })
        .on('click', '#rs_overlay', function (e) {
            if (e.target === this) $(this).remove();
        })
        .on('click', '#rs_panel .rs_close', () => $('#rs_overlay').remove())
        .on('click', '#rs_panel .rs_tab', function () {
            state.view = Number($(this).data('i'));
            renderTabs();
        })
        .on('click', '#rs_panel .rs_add_sel', () => {
            const ta = $('#rs_panel .rs_source')[0];
            addFrag(ta.value.slice(ta.selectionStart, ta.selectionEnd));
        })
        .on('click', '#rs_panel .rs_add_all', () => addFrag(state.versions[state.view]))
        .on('click', '#rs_panel .rs_up', function () { moveFrag(Number($(this).closest('.rs_frag').data('i')), -1); })
        .on('click', '#rs_panel .rs_down', function () { moveFrag(Number($(this).closest('.rs_frag').data('i')), 1); })
        .on('click', '#rs_panel .rs_del', function () { delFrag(Number($(this).closest('.rs_frag').data('i'))); })
        .on('input', '#rs_panel .rs_result', () => { state.dirty = true; })
        .on('click', '#rs_panel .rs_copy', () => copyText(String($('#rs_panel .rs_result').val())))
        .on('click', '#rs_panel .rs_save', writeBack);
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
      <label>片段分隔符（\\n 表示换行）<input type="text" id="rs_sep" class="text_pole"></label>
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
    $('#rs_sep').val(s.separator).on('input', function () {
        settings().separator = this.value;
        ctx().saveSettingsDebounced();
    });
}

// ───────────── 初始化 ─────────────

jQuery(() => {
    const c = ctx();
    const ev = c.eventTypes || c.event_types;

    renderSettings();
    injectButtons();
    bindPanelEvents();

    c.eventSource.on(ev.GENERATION_STARTED, onGenStarted);
    c.eventSource.on(ev.CHARACTER_MESSAGE_RENDERED, onCharRendered);
    c.eventSource.on(ev.GENERATION_ENDED, onGenEnded);
    c.eventSource.on(ev.GENERATION_STOPPED, onGenEnded);
    c.eventSource.on(ev.CHAT_CHANGED, () => {
        pending = null;
        injectButtons();
    });
});
