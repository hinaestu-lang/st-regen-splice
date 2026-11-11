// 重生成拼接 v0.3.0
// 1. 点「重新生成」时，把被删掉的旧回复塞回新回复的 swipes 里，左右翻就能看到
// 2. 悬浮球菜单：本楼拼接、角色卡、用户人设、世界书，都在同一个上下分屏面板里改
// 3. 角色卡 / 人设 / 世界书：可存多个命名版本随时切换；保存时自动留存改前改后，可在参考区对比

const MODULE = 'regenSplice';

const DEFAULTS = {
    enabled: true,     // 是否在重新生成时保留旧版本
    maxKeep: 20,       // 每条消息最多保留的版本数，超出会删掉最旧的（最小 2）
    ball: true,        // 是否显示悬浮球
    ballSize: 46,      // 悬浮球大小（像素，正方形是边长，原图形状是最长边），可填 30–300
    ballPos: null,     // 悬浮球位置，拖动后自动记录，不用手动改
    ballImage: '',     // 悬浮球图片：上传后自动生成，也可以填图片链接；留空用默认图标
    ballImageSize: 600, // 上传图片压缩后最长边（像素），越大越清晰、占的空间越多
    ballShape: 'square', // 有图片时的形状：square = 裁成正方形，original = 图片原形状
    splitRatio: 0.4,   // 上半屏（参考）占面板的比例，拖动横条后自动记录
    snapKeep: 30,      // 角色卡 / 人设 / 世界书每一项最多留存的存档数
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
    if (msg.swipes.length > 1 && id === ctx().chat.length - 1) {
        $mes.find('.swipe_left').css('display', 'flex');
        $mes.find('.swipe_right').css('display', 'flex');
    }
}

// ───────────── 编辑面板（消息 / 角色卡 / 用户人设 / 世界书 共用） ─────────────
// 上半屏：参考（消息是各个版本，其他是打开时的内容 + 历史存档），点句子插到下面
// 下半屏：正文，直接点就能改
// 中间横条可拖动调整上下比例

const BTN_HTML = '<div title="版本拼接" class="mes_button regen_splice_btn fa-solid fa-scissors"></div>';
const UNDO_LIMIT = 100;   // 最多可撤销的步数
const TYPING_PAUSE = 800; // 打字停顿多少毫秒算一步撤销

// 角色卡可编辑字段：[字段名, 显示名, 酒馆编辑框选择器, 是否只在 data 里]
const CHAR_FIELDS = [
    ['description', '描述', '#description_textarea', false],
    ['personality', '性格', '#personality_textarea', false],
    ['scenario', '场景', '#scenario_pole', false],
    ['first_mes', '开场白', '#firstmessage_textarea', false],
    ['mes_example', '对话示例', '#mes_example_textarea', false],
    ['system_prompt', '系统提示词', '#system_prompt_textarea', true],
    ['post_history_instructions', '后置指令', '#post_history_instructions_textarea', true],
];

function injectButtons() {
    const $tpl = $('#message_template .mes_buttons .extraMesButtons');
    if (!$tpl.find('.regen_splice_btn').length) $tpl.prepend(BTN_HTML);
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.regen_splice_btn').length) $(this).prepend(BTN_HTML);
    });
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtTime(t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 断句：句号、问号、叹号、省略号后断开，后引号跟着前一句
function splitSentences(line) {
    return line.match(/[^。！？!?…]+(?:[。！？!?…]+[”’」』"']*)|[^。！？!?…]+$/g) || [line];
}

// ───── 存档（存在浏览器本地 IndexedDB，不占酒馆设置文件） ─────

let dbPromise = null;
function db() {
    if (!dbPromise) {
        dbPromise = new Promise((res, rej) => {
            const r = indexedDB.open('regenSplice', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('snaps');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
    }
    return dbPromise;
}

async function idbGet(key) {
    try {
        const d = await db();
        return await new Promise(res => {
            const q = d.transaction('snaps').objectStore('snaps').get(key);
            q.onsuccess = () => res(q.result || []);
            q.onerror = () => res([]);
        });
    } catch {
        return [];
    }
}

async function idbPut(key, value) {
    try {
        const d = await db();
        await new Promise(res => {
            const tx = d.transaction('snaps', 'readwrite');
            tx.objectStore('snaps').put(value, key);
            tx.oncomplete = res;
            tx.onerror = res;
        });
    } catch (e) {
        console.warn('[重生成拼接] 存储失败', e);
    }
}

const getSnaps = key => idbGet(key);
const getVers = key => idbGet('ver:' + key);
const putVers = (key, arr) => idbPut('ver:' + key, arr);

// 保存时自动存档（改前 + 改后）
async function addSnaps(key, before, after) {
    let arr = await getSnaps(key);
    const push = text => {
        if (!arr.length || arr[arr.length - 1].text !== text) arr.push({ time: Date.now(), text });
    };
    push(before);
    push(after);
    const max = Math.max(2, parseInt(settings().snapKeep) || DEFAULTS.snapKeep);
    if (arr.length > max) arr = arr.slice(-max);
    await idbPut(key, arr);
}

// 参考下拉框：打开时 → 自己存的版本（★）→ 自动存档
async function buildRefs(key, initial) {
    const refs = [{ label: '打开时', text: initial }];
    (await getVers(key)).forEach(v => refs.push({ label: `★ ${v.name}`, text: v.text, verId: v.id }));
    (await getSnaps(key)).slice().reverse().forEach(sn => {
        if (sn.text !== initial) refs.push({ label: `存档 ${fmtTime(sn.time)}`, text: sn.text });
    });
    return refs;
}

// 酒馆自带弹窗（手机 app 里系统弹窗可能不显示）
async function askConfirm(msg) {
    const c = ctx();
    if (c.callGenericPopup && c.POPUP_TYPE) {
        const r = await c.callGenericPopup(msg, c.POPUP_TYPE.CONFIRM);
        return r === 1 || r === true;
    }
    return window.confirm(msg);
}

async function askInput(msg, def = '') {
    const c = ctx();
    if (c.callGenericPopup && c.POPUP_TYPE) {
        const r = await c.callGenericPopup(msg, c.POPUP_TYPE.INPUT, def);
        return typeof r === 'string' ? r : null;
    }
    return window.prompt(msg, def);
}

// ───── 各种编辑对象 ─────

function msgTarget(id) {
    const msg = ctx().chat[id];
    if (!msg) return null;
    const versions = Array.isArray(msg.swipes) && msg.swipes.length ? [...msg.swipes] : [msg.mes];
    const cur = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    versions[cur] = msg.mes;
    let ref = cur > 0 ? cur - 1 : versions.length - 1;
    if (versions.length === 1) ref = 0;
    return {
        kind: 'msg',
        title: `第 ${id} 楼`,
        pickers: '',
        refs: versions.map((t, i) => ({ label: `版本 ${i + 1}${i === cur ? '（当前）' : ''}`, text: t })),
        ref,
        initial: msg.mes,
        saveLabel: '写回',
        closeAfterSave: true,
        save: text => saveMessage(id, text),
    };
}

async function saveMessage(id, text) {
    const c = ctx();
    const msg = c.chat[id];
    if (!msg) return false;
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

    c.updateMessageBlock(id, msg);
    refreshSwipeUI(id, msg);
    await c.saveChat();
    toastr.success('已写回，原版本可左右翻找回');
    return true;
}

function currentChar() {
    const c = ctx();
    if (c.characterId === undefined || c.characterId === null || c.characterId === '') return null;
    return c.characters[c.characterId] || null;
}

async function charTarget(field = 'description') {
    const ch = currentChar();
    if (!ch) {
        toastr.warning('先打开一个角色的单人聊天');
        return null;
    }
    const def = CHAR_FIELDS.find(f => f[0] === field) || CHAR_FIELDS[0];
    const [f, , selector, dataOnly] = def;
    const initial = String((dataOnly ? ch.data?.[f] : ch[f] ?? ch.data?.[f]) ?? '');
    const key = `char:${ch.avatar}:${f}`;
    const opts = CHAR_FIELDS.map(([k, label]) => `<option value="${k}" ${k === f ? 'selected' : ''}>${label}</option>`).join('');

    return {
        kind: 'char',
        title: `角色卡：${escapeHtml(ch.name)}`,
        pickers: `<select class="rs_pick text_pole" data-pick="char">${opts}</select>`,
        refs: await buildRefs(key, initial),
        key,
        ref: 0,
        initial,
        saveLabel: '保存',
        closeAfterSave: false,
        save: async text => {
            const body = { avatar: ch.avatar, data: { [f]: text } };
            if (!dataOnly) body[f] = text;
            const res = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: ctx().getRequestHeaders(),
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                toastr.error('保存角色卡失败');
                return false;
            }
            ch.data = ch.data || {};
            ch.data[f] = text;
            if (!dataOnly) ch[f] = text;
            if (selector) $(selector).val(text); // 同步酒馆自己的编辑框，避免被旧内容覆盖
            await addSnaps(key, initial, text);
            toastr.success('角色卡已保存');
            return true;
        },
    };
}

async function personaTarget() {
    const c = ctx();
    const $box = $('#persona_description');
    if (!$box.length) {
        toastr.warning('找不到用户人设');
        return null;
    }
    const initial = String($box.val() ?? '');
    const key = `persona:${c.name1}`;
    return {
        kind: 'persona',
        title: `用户人设：${escapeHtml(c.name1)}`,
        pickers: '',
        refs: await buildRefs(key, initial),
        key,
        ref: 0,
        initial,
        saveLabel: '保存',
        closeAfterSave: false,
        save: async text => {
            $('#persona_description').val(text).trigger('input'); // 交给酒馆自己保存
            await addSnaps(key, initial, text);
            toastr.success('用户人设已保存');
            return true;
        },
    };
}

function worldNames() {
    return $('#world_editor_select option').map(function () {
        return $(this).val() === '' ? null : $(this).text();
    }).get().filter(Boolean);
}

async function worldTarget(book, uid) {
    const c = ctx();
    const names = worldNames();
    if (!names.length) {
        toastr.warning('还没有世界书');
        return null;
    }
    if (!book || !names.includes(book)) {
        const bound = currentChar()?.data?.extensions?.world;
        const globalOn = $('#world_info option:selected').first().text();
        book = names.includes(bound) ? bound : names.includes(globalOn) ? globalOn : names[0];
    }

    const data = await c.loadWorldInfo(book);
    const entries = Object.values(data?.entries || {})
        .sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));

    const bookOpts = names.map(n => `<option ${n === book ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
    if (!entries.length) {
        return {
            kind: 'world', title: '世界书',
            pickers: `<select class="rs_pick text_pole" data-pick="book">${bookOpts}</select>`,
            refs: [{ label: '打开时', text: '' }], ref: 0, initial: '', empty: '这本世界书还没有条目',
            saveLabel: '保存', closeAfterSave: false, save: async () => false,
        };
    }

    const entry = entries.find(e => String(e.uid) === String(uid)) || entries[0];
    const entryLabel = e => e.comment || (Array.isArray(e.key) && e.key.join('、')) || `条目 ${e.uid}`;
    const entryOpts = entries.map(e =>
        `<option value="${e.uid}" ${e === entry ? 'selected' : ''}>${escapeHtml(entryLabel(e))}${e.disable ? '（已禁用）' : ''}</option>`).join('');
    const initial = String(entry.content ?? '');
    const key = `wi:${book}:${entry.uid}`;

    return {
        kind: 'world',
        title: '世界书',
        pickers: `<select class="rs_pick text_pole" data-pick="book">${bookOpts}</select>
<select class="rs_pick text_pole" data-pick="entry">${entryOpts}</select>
${wiToggleHtml(!entry.disable)}`,
        book,
        uid: entry.uid,
        refs: await buildRefs(key, initial),
        key,
        ref: 0,
        initial,
        saveLabel: '保存',
        closeAfterSave: false,
        save: async text => {
            const fresh = await ctx().loadWorldInfo(book);
            if (!fresh?.entries?.[entry.uid]) {
                toastr.error('这个条目已经不存在了');
                return false;
            }
            fresh.entries[entry.uid].content = text;
            await ctx().saveWorldInfo(book, fresh, true);
            try { ctx().reloadWorldInfoEditor?.(book, false); } catch { /* 编辑器没打开时忽略 */ }
            await addSnaps(key, initial, text);
            toastr.success('世界书条目已保存');
            return true;
        },
    };
}

function wiToggleHtml(on) {
    return `<div class="rs_wi_toggle ${on ? 'rs_on' : ''}" title="启用或禁用这个条目">
<i class="fa-solid ${on ? 'fa-toggle-on' : 'fa-toggle-off'}"></i><span>${on ? '启用' : '禁用'}</span></div>`;
}

async function toggleWorldEntry() {
    const t = state.target;
    if (t?.kind !== 'world' || t.uid === undefined) return;
    const c = ctx();
    const fresh = await c.loadWorldInfo(t.book);
    const entry = fresh?.entries?.[t.uid];
    if (!entry) {
        toastr.error('这个条目已经不存在了');
        return;
    }
    entry.disable = !entry.disable;
    await c.saveWorldInfo(t.book, fresh, true);
    try { c.reloadWorldInfoEditor?.(t.book, false); } catch { /* 编辑器没打开时忽略 */ }

    const on = !entry.disable;
    $('#rs_panel .rs_wi_toggle').replaceWith(wiToggleHtml(on));
    const $opt = $(`#rs_panel .rs_pick[data-pick="entry"] option[value="${t.uid}"]`);
    $opt.text($opt.text().replace(/（已禁用）$/, '') + (on ? '' : '（已禁用）'));
    toastr.success(on ? '条目已启用' : '条目已禁用');
}

// ───── 面板 ─────

const state = {
    target: null,
    ref: 0,
    used: new Set(),
    diff: false,
    caret: null,
    undo: [],
    redo: [],
    last: null,
    typing: false,
    typingTimer: null,
    diffTimer: null,
};

const bodyEl = () => $('#rs_panel .rs_body_text')[0];
const snap = () => {
    const ta = bodyEl();
    return { v: ta.value, s: ta.selectionStart, e: ta.selectionEnd };
};
const isDirty = () => !!state.target && !!bodyEl() && bodyEl().value !== state.target.initial;

function ensureShell() {
    if ($('#rs_overlay').length) return;
    $('body').append(`
<div id="rs_overlay">
  <div id="rs_panel">
    <div class="rs_bar rs_top">
      <div class="rs_bar_title rs_title"></div>
      <div class="rs_icon rs_close fa-solid fa-xmark" title="关闭"></div>
    </div>
    <div class="rs_pickers"></div>
    <div class="rs_bar">
      <div class="rs_bar_title">参考</div>
      <div class="rs_icon rs_diff fa-solid fa-highlighter" title="标出正文里没有的句子"></div>
      <div class="rs_icon rs_use fa-solid fa-file-import" title="整篇换成这一版"></div>
      <div class="rs_icon rs_ver_del fa-solid fa-trash-can" title="删除这个版本"></div>
      <select class="rs_ref text_pole"></select>
    </div>
    <div class="rs_ref_pane"></div>
    <div class="rs_grip"><span></span></div>
    <div class="rs_bar">
      <div class="rs_bar_title">正文</div>
      <div class="rs_icon rs_undo fa-solid fa-rotate-left" title="撤销"></div>
      <div class="rs_icon rs_redo fa-solid fa-rotate-right" title="恢复"></div>
      <div class="rs_icon rs_ver_add fa-solid fa-bookmark" title="存为版本"></div>
      <div class="menu_button rs_save">保存</div>
    </div>
    <textarea class="rs_body_text" spellcheck="false"></textarea>
  </div>
</div>`);
    const ratio = Math.min(0.8, Math.max(0.15, Number(settings().splitRatio) || DEFAULTS.splitRatio));
    $('#rs_panel .rs_ref_pane').css('height', Math.round($('#rs_panel').height() * ratio) + 'px');
}

function showTarget(t) {
    if (!t) return;
    ensureShell();
    Object.assign(state, { target: t, ref: t.ref, used: new Set(), caret: null, undo: [], redo: [], typing: false });

    $('#rs_panel .rs_title').html(t.title);
    $('#rs_panel .rs_pickers').html(t.pickers).toggle(!!t.pickers);
    $('#rs_panel .rs_ref').html(t.refs.map((r, i) => `<option value="${i}">${escapeHtml(r.label)}</option>`).join('')).val(String(t.ref));
    $('#rs_panel .rs_save').text(t.saveLabel);
    state.diff = t.kind !== 'msg';
    $('#rs_panel .rs_diff').toggle(t.kind !== 'msg').toggleClass('rs_on', state.diff);
    $('#rs_panel .rs_ver_add').toggle(!!t.key && !t.empty);
    updateRefButtons();

    const ta = bodyEl();
    ta.value = t.initial;
    ta.placeholder = t.empty || '';
    ta.readOnly = !!t.empty;
    state.last = snap();
    renderRef();
    updateUndoButtons();
    $('#rs_panel .rs_ref_pane').scrollTop(0);
    ta.scrollTop = 0;
}

async function switchTarget(loader) {
    if (isDirty() && !(await askConfirm('正文改了还没保存，切换会丢掉改动，继续吗？'))) return false;
    const t = await loader();
    if (!t) return false;
    showTarget(t);
    return true;
}

function updateRefButtons() {
    const r = state.target?.refs[state.ref];
    $('#rs_panel .rs_ver_del').toggle(!!r?.verId);
}

async function refreshRefs(selectVerId) {
    const t = state.target;
    t.refs = await buildRefs(t.key, t.initial);
    let idx = selectVerId ? t.refs.findIndex(r => r.verId === selectVerId) : Math.min(state.ref, t.refs.length - 1);
    if (idx < 0) idx = 0;
    state.ref = idx;
    state.used = new Set();
    $('#rs_panel .rs_ref').html(t.refs.map((r, i) => `<option value="${i}">${escapeHtml(r.label)}</option>`).join('')).val(String(idx));
    updateRefButtons();
    renderRef();
}

async function saveAsVersion() {
    const t = state.target;
    if (!t?.key || saving) return;
    const text = String(bodyEl().value);
    if (!text.trim()) {
        toastr.warning('正文是空的');
        return;
    }
    const name = await askInput('给这个版本起个名字', '');
    if (name === null) return;
    const arr = await getVers(t.key);
    const id = Date.now().toString(36);
    arr.push({ id, name: name.trim() || fmtTime(Date.now()), time: Date.now(), text });
    await putVers(t.key, arr);
    await refreshRefs(id);
    toastr.success('已存为版本，在参考下拉框里能找到');
}

async function deleteVersion() {
    const t = state.target;
    const r = t?.refs[state.ref];
    if (!r?.verId) return;
    if (!(await askConfirm(`删除版本「${r.label.replace(/^★ /, '')}」？`))) return;
    await putVers(t.key, (await getVers(t.key)).filter(v => v.id !== r.verId));
    state.ref = 0;
    await refreshRefs();
    toastr.success('版本已删除');
}

function useRefWhole() {
    const ta = bodyEl();
    if (ta.readOnly) return;
    const text = state.target?.refs[state.ref]?.text ?? '';
    if (ta.value === text) {
        toastr.info('正文已经是这一版了');
        return;
    }
    state.typing = false;
    pushUndo();
    ta.value = text;
    state.caret = null;
    state.last = snap();
    updateUndoButtons();
    if (state.diff) renderRef();
    toastr.info('已放进正文，点保存才会生效');
}

function renderRef() {
    const t = state.target;
    const refText = t.refs[state.ref]?.text ?? '';
    if (!refText.trim()) {
        const tip = t.kind === 'msg' ? '' : '还没有存档。保存后会自动留存改前和改后的内容，之后可以在这里对比。';
        $('#rs_panel .rs_ref_pane').html(`<div class="rs_empty">${tip}</div>`);
        return;
    }
    const body = state.diff ? bodyEl().value : '';
    const html = String(refText).split('\n').map((line, li) => {
        if (!line.trim()) return '';
        const spans = splitSentences(line).map((s, si) => {
            const k = `${state.ref}-${li}-${si}`;
            const cls = state.used.has(k) ? 'rs_used' : (state.diff && !body.includes(s.trim()) ? 'rs_gone' : '');
            return `<span class="rs_s ${cls}" data-k="${k}">${escapeHtml(s)}</span>`;
        }).join('');
        return `<p>${spans}</p>`;
    }).join('');
    $('#rs_panel .rs_ref_pane').html(html);
}

function pushUndo() {
    state.undo.push(state.last);
    if (state.undo.length > UNDO_LIMIT) state.undo.shift();
    state.redo = [];
}

function applySnap(sn) {
    const ta = bodyEl();
    ta.value = sn.v;
    state.caret = { s: sn.s, e: sn.e };
    try { ta.setSelectionRange(sn.s, sn.e); } catch { /* 忽略 */ }
    state.last = snap();
    if (state.diff) renderRef();
}

function updateUndoButtons() {
    $('#rs_panel .rs_undo').toggleClass('rs_off', !state.undo.length);
    $('#rs_panel .rs_redo').toggleClass('rs_off', !state.redo.length);
}

function insertSentence(text, key) {
    const ta = bodyEl();
    if (ta.readOnly) return;
    const val = ta.value;
    let s = val.length;
    let e = val.length;
    if (state.caret) {
        s = Math.min(state.caret.s, val.length);
        e = Math.min(state.caret.e, val.length);
    }
    state.typing = false;
    pushUndo();
    ta.value = val.slice(0, s) + text + val.slice(e);
    const pos = s + text.length;
    state.caret = { s: pos, e: pos };
    try { ta.setSelectionRange(pos, pos); } catch { /* 忽略 */ }
    state.last = { v: ta.value, s: pos, e: pos };
    state.used.add(key);
    renderRef();
    updateUndoButtons();

    ta.classList.remove('rs_flash');
    void ta.offsetWidth;
    ta.classList.add('rs_flash');
}

function onBodyInput() {
    const ta = bodyEl();
    if (!state.typing) pushUndo();
    state.typing = true;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => { state.typing = false; }, TYPING_PAUSE);
    state.caret = { s: ta.selectionStart, e: ta.selectionEnd };
    state.last = snap();
    updateUndoButtons();
    if (state.diff) {
        clearTimeout(state.diffTimer);
        state.diffTimer = setTimeout(renderRef, 400);
    }
}

function doUndo() {
    if (!state.undo.length) return;
    state.typing = false;
    state.redo.push(snap());
    applySnap(state.undo.pop());
    updateUndoButtons();
}

function doRedo() {
    if (!state.redo.length) return;
    state.typing = false;
    state.undo.push(snap());
    applySnap(state.redo.pop());
    updateUndoButtons();
}

let gripDrag = null;
function onGripDown(e) {
    gripDrag = { y: e.clientY, h: $('#rs_panel .rs_ref_pane')[0].offsetHeight };
    e.target.setPointerCapture?.(e.pointerId);
}
function onGripMove(e) {
    if (!gripDrag) return;
    const total = $('#rs_panel').height();
    const h = Math.min(total * 0.8, Math.max(total * 0.15, gripDrag.h + e.clientY - gripDrag.y));
    $('#rs_panel .rs_ref_pane').css('height', h + 'px');
}
function onGripUp() {
    if (!gripDrag) return;
    gripDrag = null;
    settings().splitRatio = $('#rs_panel .rs_ref_pane').height() / $('#rs_panel').height();
    ctx().saveSettingsDebounced();
}

async function closePanel(force = false) {
    if (!force && isDirty() && !(await askConfirm('正文改了还没保存，确定关闭吗？'))) return;
    clearTimeout(state.typingTimer);
    clearTimeout(state.diffTimer);
    state.target = null;
    $('#rs_overlay').remove();
}

let saving = false;
async function onSave() {
    const t = state.target;
    if (!t || saving) return;
    const text = String(bodyEl().value);
    if (t.empty) return;
    if (text === t.initial) {
        toastr.info('没有改动');
        return;
    }
    if (t.kind === 'msg' && !text.trim()) {
        toastr.warning('正文是空的');
        return;
    }
    saving = true;
    const $btn = $('#rs_panel .rs_save').addClass('rs_off');
    let ok = false;
    try {
        ok = await t.save(text);
    } catch (e) {
        console.error('[重生成拼接] 保存失败', e);
        toastr.error('保存失败，内容还在面板里，可以再试一次');
    } finally {
        saving = false;
        $btn.removeClass('rs_off');
    }
    if (!ok) return;
    if (t.closeAfterSave) {
        closePanel(true);
        return;
    }
    // 留在面板里，刷新存档列表
    t.initial = text;
    reloadCurrent();
}

async function reloadCurrent() {
    const t = state.target;
    if (t.kind === 'char') showTarget(await charTarget($('#rs_panel .rs_pick[data-pick="char"]').val()));
    else if (t.kind === 'persona') showTarget(await personaTarget());
    else if (t.kind === 'world') showTarget(await worldTarget(t.book, $('#rs_panel .rs_pick[data-pick="entry"]').val()));
}

// 对外入口
function openPanel(id) {
    showTarget(msgTarget(id));
}

// ───── 悬浮球菜单 ─────

function openMenu() {
    if ($('#rs_menu').length) {
        $('#rs_menu').remove();
        return;
    }
    const ball = document.getElementById('rs_ball');
    const r = ball.getBoundingClientRect();
    const $m = $(`
<div id="rs_menu">
  <div class="rs_menu_item" data-go="msg"><i class="fa-solid fa-scissors"></i>本楼拼接</div>
  <div class="rs_menu_item" data-go="char"><i class="fa-solid fa-id-card"></i>角色卡</div>
  <div class="rs_menu_item" data-go="persona"><i class="fa-solid fa-user"></i>用户人设</div>
  <div class="rs_menu_item" data-go="world"><i class="fa-solid fa-book-atlas"></i>世界书</div>
</div>`).appendTo('body');
    const w = $m.outerWidth();
    const h = $m.outerHeight();
    const left = r.left + r.width / 2 > window.innerWidth / 2 ? r.left - w - 8 : r.right + 8;
    const top = Math.min(Math.max(8, r.top + r.height / 2 - h / 2), window.innerHeight - h - 8);
    $m.css({ left: Math.max(8, left) + 'px', top: top + 'px' });
}

async function onMenuPick(go) {
    $('#rs_menu').remove();
    if (go === 'msg') {
        const id = lastAiIndex();
        if (id < 0) return toastr.warning('当前聊天里还没有 AI 回复');
        openPanel(id);
    } else if (go === 'char') {
        showTarget(await charTarget());
    } else if (go === 'persona') {
        showTarget(await personaTarget());
    } else if (go === 'world') {
        showTarget(await worldTarget());
    }
}

function bindPanelEvents() {
    $(document)
        .on('click', '.regen_splice_btn', function () {
            openPanel(Number($(this).closest('.mes').attr('mesid')));
        })
        .on('pointerdown', '#rs_overlay', function (e) {
            this.dataset.downOnSelf = e.target === this ? '1' : '';
        })
        .on('click', '#rs_overlay', function (e) {
            if (e.target === this && this.dataset.downOnSelf === '1') closePanel();
        })
        .on('click', '#rs_panel .rs_close', () => closePanel())
        .on('change', '#rs_panel .rs_ref', function () {
            state.ref = Number(this.value);
            state.used = new Set();
            updateRefButtons();
            renderRef();
            $('#rs_panel .rs_ref_pane').scrollTop(0);
        })
        .on('change', '#rs_panel .rs_pick', async function () {
            const pick = $(this).data('pick');
            const val = $(this).val();
            const prev = this.dataset.prev ?? $(this).find('option[selected]').val();
            let ok = true;
            if (pick === 'char') ok = await switchTarget(() => charTarget(val));
            if (pick === 'book') ok = await switchTarget(() => worldTarget(val));
            if (pick === 'entry') ok = await switchTarget(() => worldTarget(state.target.book, val));
            if (!ok && prev !== undefined) $(this).val(prev);
        })
        .on('click', '#rs_panel .rs_wi_toggle', toggleWorldEntry)
        .on('click', '#rs_panel .rs_ver_add', saveAsVersion)
        .on('click', '#rs_panel .rs_ver_del', deleteVersion)
        .on('click', '#rs_panel .rs_use', useRefWhole)
        .on('click', '#rs_panel .rs_diff', function () {
            state.diff = !state.diff;
            $(this).toggleClass('rs_on', state.diff);
            renderRef();
        })
        .on('click', '#rs_panel .rs_s', function () {
            insertSentence($(this).text(), String($(this).data('k')));
        })
        .on('input', '#rs_panel .rs_body_text', onBodyInput)
        .on('click keyup select', '#rs_panel .rs_body_text', function () {
            state.caret = { s: this.selectionStart, e: this.selectionEnd };
        })
        .on('click', '#rs_panel .rs_undo', doUndo)
        .on('click', '#rs_panel .rs_redo', doRedo)
        .on('click', '#rs_panel .rs_save', onSave)
        .on('pointerdown', '#rs_panel .rs_grip', e => onGripDown(e.originalEvent))
        .on('pointermove', '#rs_panel .rs_grip', e => onGripMove(e.originalEvent))
        .on('pointerup pointercancel', '#rs_panel .rs_grip', onGripUp)
        .on('click', '#rs_menu .rs_menu_item', function () { onMenuPick($(this).data('go')); })
        .on('pointerdown', e => {
            if ($('#rs_menu').length && !$(e.target).closest('#rs_menu, #rs_ball').length) $('#rs_menu').remove();
        });

    document.addEventListener('selectionchange', () => {
        const ta = document.querySelector('#rs_panel .rs_body_text');
        if (ta && document.activeElement === ta) state.caret = { s: ta.selectionStart, e: ta.selectionEnd };
    });
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
    const el = document.getElementById('rs_ball');
    const w = el?.offsetWidth || settings().ballSize;
    const h = el?.offsetHeight || settings().ballSize;
    return {
        x: Math.min(Math.max(0, x), window.innerWidth - w),
        y: Math.min(Math.max(0, y), window.innerHeight - h),
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

    const $b = $('<div id="rs_ball" title="编辑"></div>').appendTo('body');
    $b.css({ width: s.ballSize + 'px', height: s.ballSize + 'px', fontSize: Math.round(s.ballSize * 0.4) + 'px' });
    if (s.ballImage && s.ballShape !== 'original') {
        $b.addClass('rs_ball_img').css('background-image', `url("${String(s.ballImage).replace(/"/g, '%22')}")`);
    } else if (s.ballImage) {
        // 原形状：不裁剪、不加底色和边框，透明的地方就是透明
        $b.addClass('rs_ball_raw').css({ width: 'auto', height: 'auto' });
        $('<img>', { src: s.ballImage, draggable: false, alt: '' })
            .css({ maxWidth: s.ballSize + 'px', maxHeight: s.ballSize + 'px' })
            .on('load', () => placeBall($b[0].offsetLeft, $b[0].offsetTop))
            .appendTo($b);
    } else {
        $b.addClass('fa-solid fa-pen-nib');
    }

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
        openMenu();
    });

    el.addEventListener('pointercancel', () => { drag = null; });
}

// 把上传的图片按比例压缩，保留透明背景，存进设置里
function imageToDataUrl(file) {
    return new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onerror = () => rej(reader.error);
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => rej(new Error('图片读取失败'));
            img.onload = () => {
                const max = Math.max(64, parseInt(settings().ballImageSize) || DEFAULTS.ballImageSize);
                const scale = Math.min(1, max / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                res(canvas.toDataURL('image/png'));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
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
      <label>悬浮球大小（像素，30–300）<input type="number" id="rs_ball_size" class="text_pole" min="30" max="300"></label>
      <div>悬浮球图片</div>
      <div class="rs_ball_img_row">
        <div class="menu_button" id="rs_ball_upload">上传图片</div>
        <div class="menu_button" id="rs_ball_clear">恢复默认</div>
        <input type="file" accept="image/*" id="rs_ball_file" hidden>
      </div>
      <input type="text" id="rs_ball_url" class="text_pole" placeholder="或者粘贴图片链接">
      <label>图片形状
        <select id="rs_ball_shape" class="text_pole">
          <option value="square">正方形</option>
          <option value="original">原图形状</option>
        </select>
      </label>
      <label>每一项最多留存的存档数<input type="number" id="rs_snap_keep" class="text_pole" min="2"></label>
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
        settings().ballSize = Math.min(300, Math.max(30, parseInt(this.value) || DEFAULTS.ballSize));
        $(this).val(settings().ballSize);
        ctx().saveSettingsDebounced();
        renderBall();
    });
    const setBallImage = v => {
        settings().ballImage = v;
        ctx().saveSettingsDebounced();
        renderBall();
    };
    $('#rs_ball_url').val(String(s.ballImage).startsWith('data:') ? '' : s.ballImage).on('change', function () {
        setBallImage(this.value.trim());
    });
    $('#rs_ball_shape').val(s.ballShape === 'original' ? 'original' : 'square').on('change', function () {
        settings().ballShape = this.value;
        ctx().saveSettingsDebounced();
        renderBall();
    });
    $('#rs_ball_upload').on('click', () => $('#rs_ball_file').trigger('click'));
    $('#rs_ball_file').on('change', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;
        try {
            setBallImage(await imageToDataUrl(file));
            $('#rs_ball_url').val('');
            toastr.success('悬浮球图片已更换');
        } catch {
            toastr.error('这张图片读取失败，换一张试试');
        }
    });
    $('#rs_ball_clear').on('click', () => {
        $('#rs_ball_url').val('');
        setBallImage('');
    });
    $('#rs_snap_keep').val(s.snapKeep).on('input', function () {
        settings().snapKeep = Math.max(2, parseInt(this.value) || DEFAULTS.snapKeep);
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
