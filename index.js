
const MODULE = 'regenSplice';

const DEFAULTS = {
    enabled: true,
    maxKeep: 20,
    ball: true,
    ballSize: 46,
    ballPos: null,
    ballImage: '',
    ballImageSize: 600,
    ballShape: 'square',
    splitRatio: 0.4,
    snapKeep: 30,
    lastKind: 'msg',
    findExclude: '',
    readerTheme: 'paper',
    readerColors: null,
    readerFont: 19,
    readerIndent: false,
    readerShowTime: true,
    readerMarkdown: true,
    readerQuote: true,
    readerHideCode: true,
    readerBook: '',
    readerSign: '',
    readerBody: 'content',
    readerHide: 'think thinking',
    libMax: 500,
    clicheOn: true,
    versionChip: true,
    tapEdit: true,
    selectGuard: true,
    editBodyOnly: true,
    branchChip: true,
    clicheWhole: true,
    clicheWords: [
        '猎人', '猎物', '共犯', '极其', '居高临下', '语气', '这是一个', '那是一个',
        '投石', '/投入.{0,8}(石子|石头)/', '/石子.{0,8}(湖|水)面/',
        '扎针', '/针.{0,4}扎|扎.{0,4}针|像.{0,6}针/',
    ].join('\n'),
};

const ctx = () => SillyTavern.getContext();

function settings() {
    const es = ctx().extensionSettings;
    if (!es[MODULE] || typeof es[MODULE] !== 'object') es[MODULE] = {};
    const s = es[MODULE];
    for (const k of Object.keys(DEFAULTS)) {
        if (!(k in s)) s[k] = DEFAULTS[k];
    }
    return s;
}

let pending = null;

function onGenStarted(type, _opts, dryRun) {
    if (dryRun) return;
    pending = null;
    if (type !== 'regenerate' || !settings().enabled) return;

    const chat = ctx().chat;
    const last = chat[chat.length - 1];
    if (!last || last.is_user || last.is_system) return;

    const sid = Number.isInteger(last.swipe_id) ? last.swipe_id : 0;
    const swipes = Array.isArray(last.swipes) && last.swipes.length ? [...last.swipes] : [last.mes];
    swipes[sid] = last.mes;

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

function onGenEnded() {
    if (!pending) return;
    setTimeout(async () => {
        if (!pending) return;
        const c = ctx();
        if (c.chat.length !== pending.index) return;
        const p = pending;
        pending = null;
        c.chat.push(p.msg);
        c.addOneMessage(p.msg);
        await c.saveChat();
        toastr.info('生成未完成，已恢复上一版回复');
    }, 500);
}

function refreshSwipeUI(id, msg) {
    updateVersionChip(id);
    const $mes = $(`#chat .mes[mesid="${id}"]`);
    $mes.find('.swipes-counter').text(`${msg.swipe_id + 1}/${msg.swipes.length}`);
    if (msg.swipes.length > 1 && id === ctx().chat.length - 1) {
        $mes.find('.swipe_left').css('display', 'flex');
        $mes.find('.swipe_right').css('display', 'flex');
    }
}

const BTN_HTML = '<div title="版本拼接" class="mes_button regen_splice_btn fa-solid fa-scissors"></div>';
const UNDO_LIMIT = 100;
const TYPING_PAUSE = 800;

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

function eachMatch(re, text, fn) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
        if (!m[0]) {
            re.lastIndex++;
            continue;
        }
        fn(m);
    }
}

function tagBlockRe(name, flags = 'gi') {
    const e = escapeRe(name);
    return new RegExp(`<${e}(?:\\s[^>]*)?>([\\s\\S]*?)(?:</${e}\\s*>|$)`, flags);
}

function previewText(text, max) {
    const one = (readerDisplay(text).text || String(text ?? '')).replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max) + '…' : one || '（空）';
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmtTime(t) {
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function splitSentences(line) {
    return line.match(/[^。！？!?…]*[。！？!?…]+[”’」』"']*|[^。！？!?…]+$/g) || [line];
}

function sentenceSet(text) {
    const set = new Set();
    String(text).split('\n').forEach(line => {
        if (line.trim()) splitSentences(line).forEach(x => x.trim() && set.add(x.trim()));
    });
    return set;
}

function eachSentence(text, fn) {
    let off = 0;
    String(text).split('\n').forEach(line => {
        let pos = off;
        if (line) {
            splitSentences(line).forEach(sen => {
                fn(sen, pos, pos + sen.length);
                pos += sen.length;
            });
        }
        off += line.length + 1;
    });
}

function addedRanges(text, refSet) {
    const out = [];
    eachSentence(text, (sen, a, b) => {
        if (sen.trim() && !refSet.has(sen.trim())) out.push([a, b]);
    });
    return out;
}

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
const getLib = () => idbGet('library');
const putLib = arr => idbPut('library', arr);
const getVers = key => idbGet('ver:' + key);
const putVers = (key, arr) => idbPut('ver:' + key, arr);

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

async function buildRefs(key, initial) {
    const refs = [{ label: '打开时', text: initial }];
    (await getVers(key)).forEach(v => refs.push({ label: `★ ${v.name}`, text: v.text, verId: v.id }));
    (await getSnaps(key)).slice().reverse().forEach(sn => {
        if (sn.text !== initial) refs.push({ label: `存档 ${fmtTime(sn.time)}`, text: sn.text });
    });
    return refs;
}

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

function splitBody(raw) {
    raw = String(raw ?? '');
    const whole = { pre: '', body: raw, post: '' };
    const name = tagNames(settings().readerBody)[0];
    if (!settings().editBodyOnly || !name) return whole;
    const e = escapeRe(name);
    const m = new RegExp(`(<${e}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${e}\\s*>)`, 'i').exec(raw);
    if (!m) return whole;
    const lines = m[2].split('\n');
    const fixed = l => !l.trim() || /^\s*(?:<([A-Za-z_][\w-]*)[^>]*>[^<]*<\/\1\s*>|<\/?[A-Za-z_][\w-]*[^>]*>)\s*$/.test(l);
    let i = 0;
    while (i < lines.length && fixed(lines[i])) i++;
    let j = lines.length;
    while (j > i && fixed(lines[j - 1])) j--;
    if (i >= j) return whole;
    return {
        pre: raw.slice(0, m.index) + m[1] + (i ? lines.slice(0, i).join('\n') + '\n' : ''),
        body: lines.slice(i, j).join('\n'),
        post: (j < lines.length ? '\n' + lines.slice(j).join('\n') : '') + m[3] + raw.slice(m.index + m[0].length),
    };
}

function msgTarget(id) {
    const msg = ctx().chat[id];
    if (!msg) return null;
    const versions = Array.isArray(msg.swipes) && msg.swipes.length ? [...msg.swipes] : [msg.mes];
    const cur = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    versions[cur] = msg.mes;
    let ref = cur > 0 ? cur - 1 : versions.length - 1;
    const chat = ctx().chat;
    const floors = chat
        .map((m, i) => ({ m, i }))
        .filter(({ m, i }) => i !== id && m && String(m.mes ?? '').trim())
        .sort((x, y) => Math.abs(x.i - id) - Math.abs(y.i - id) || y.i - x.i)
        .map(({ m, i }) => ({ label: `第 ${i} 楼 ${m.name || ''}${m.is_system ? '（已隐藏）' : ''}`, text: splitBody(m.mes).body, group: '其他楼层' }));
    if (versions.length === 1) ref = floors.length ? 1 : 0;
    const parts = splitBody(msg.mes);
    return {
        kind: 'msg',
        id,
        draftKey: `msg:${ctx().getCurrentChatId?.() ?? ''}:${id}${parts.pre || parts.post ? ':body' : ''}`,
        subtitle: `第 ${id} 楼`,
        pickers: '',
        refs: [
            ...versions.map((t, i) => ({ label: `版本 ${i + 1}${i === cur ? '（当前）' : ''}`, text: splitBody(t).body, group: '这一楼的版本' })),
            ...floors,
        ],
        ref,
        initial: parts.body,
        bodyOnly: !!(parts.pre || parts.post),
        saveLabel: '写回',
        closeAfterSave: true,
        save: text => saveMessage(id, parts.pre + text + parts.post),
    };
}

const VERSION_PREVIEW = 60;

function versionCount(m) {
    return Array.isArray(m?.swipes) ? m.swipes.length : 0;
}

function mesEl(id) {
    return document.querySelector(`#chat .mes[mesid="${id}"]`);
}

function ensureChip(el, cls, html) {
    const old = el.querySelector(`.${cls}`);
    if (old) return $(old);
    const $chip = $(html);
    const host = el.querySelector('.ch_name') || el.querySelector('.mes_block') || el;
    if (host.classList.contains('ch_name')) host.append($chip[0]);
    else host.prepend($chip[0]);
    return $chip;
}

function updateVersionChip(id, el = mesEl(id)) {
    if (!el) return;
    const m = ctx().chat[id];
    const n = versionCount(m);
    if (!settings().versionChip || n < 2) {
        el.querySelector('.rs_vchip')?.remove();
        return;
    }
    const $chip = ensureChip(el, 'rs_vchip', '<span class="rs_vchip"><span class="rs_vchip_arrow" data-d="-1">‹</span><span class="rs_vchip_num"></span><span class="rs_vchip_arrow" data-d="1">›</span></span>');
    const cur = Number.isInteger(m.swipe_id) ? m.swipe_id : 0;
    $chip.find('.rs_vchip_num').text(`${cur + 1}/${n}`);
    $chip.attr('data-id', id);
}

function updateChipsOf(el) {
    const id = Number(el.getAttribute('mesid'));
    updateVersionChip(id, el);
    updateBranchChip(id, el);
}

function updateAllVersionChips() {
    document.querySelectorAll('#chat .mes[mesid]').forEach(updateChipsOf);
}

function updateChipsById(id) {
    const el = Number.isInteger(Number(id)) ? mesEl(Number(id)) : null;
    if (el) updateChipsOf(el);
    else updateAllVersionChips();
}

const BRANCH_CACHE_KEY = 'regenSplice:branchMain';
const branchMainCache = new Map((() => {
    try {
        return Object.entries(JSON.parse(localStorage.getItem(BRANCH_CACHE_KEY) || '{}'));
    } catch {
        return [];
    }
})());

function saveBranchCache() {
    try {
        localStorage.setItem(BRANCH_CACHE_KEY, JSON.stringify(Object.fromEntries(branchMainCache)));
    } catch { }
}
let branchInfo = null;
let branchLoading = null;

async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.json();
}

async function chatMain(ch, file) {
    if (branchMainCache.has(file)) return branchMainCache.get(file);
    let main = null;
    try {
        const data = await postJson('/api/chats/get', { ch_name: ch.name, file_name: file, avatar_url: ch.avatar });
        main = (Array.isArray(data) ? data[0] : null)?.chat_metadata?.main_chat ?? null;
    } catch { }
    branchMainCache.set(file, main);
    return main;
}

const branchAt = file => {
    const m = String(file).match(/^Branch #(\d+) - /);
    return m ? Number(m[1]) : null;
};

async function loadBranches() {
    const c = ctx();
    const ch = currentChar();
    if (!ch || c.groupId || !settings().branchChip) {
        branchInfo = null;
        return;
    }
    const cur = c.getCurrentChatId?.() ?? ch.chat;
    let list = await postJson('/api/characters/chats', { avatar_url: ch.avatar, simple: true });
    list = Array.isArray(list) ? list : Object.values(list || {});
    const chats = list
        .map(x => ({ file: String(x.file_name || '').replace(/\.jsonl$/, ''), last: String(x.mes ?? ''), date: x.last_mes ?? '' }))
        .filter(x => x.file);
    const parent = c.chatMetadata?.main_chat || null;
    const curAt = branchAt(cur);
    const groups = new Map();
    const push = (k, x) => {
        if (!groups.has(k)) groups.set(k, []);
        if (!groups.get(k).some(y => y.file === x.file)) groups.get(k).push(x);
    };
    const candidates = chats.filter(x => x.file !== cur && branchAt(x.file) !== null);
    const mains = [];
    for (let i = 0; i < candidates.length; i += 3) {
        mains.push(...await Promise.all(candidates.slice(i, i + 3).map(x => chatMain(ch, x.file))));
    }
    saveBranchCache();
    candidates.forEach((x, i) => {
        const k = branchAt(x.file);
        if (mains[i] === cur) push(k, { ...x, rel: '分支' });
        else if (parent && mains[i] === parent && k === curAt) push(k, { ...x, rel: '同级分支' });
    });
    if (parent && curAt !== null) {
        push(curAt, { ...(chats.find(x => x.file === parent) || { file: parent, last: '', date: '' }), rel: '主线' });
    }
    c.chat.forEach((m, i) => {
        const link = m?.extra?.bookmark_link;
        const x = link && link !== cur && chats.find(y => y.file === link);
        if (x) push(i, { ...x, rel: '存档点' });
    });
    branchInfo = { cur, groups };
}

function refreshBranches() {
    if (branchLoading) return branchLoading;
    branchLoading = loadBranches()
        .catch(e => {
            console.warn('[重生成拼接] 读取分支失败', e);
            branchInfo = null;
        })
        .finally(() => {
            branchLoading = null;
            updateAllVersionChips();
        });
    return branchLoading;
}

function updateBranchChip(id, el = mesEl(id)) {
    if (!el) return;
    const list = settings().branchChip ? branchInfo?.groups.get(id) : null;
    if (!list?.length) {
        el.querySelector('.rs_bchip')?.remove();
        return;
    }
    const $chip = ensureChip(el, 'rs_bchip', '<span class="rs_bchip"><i class="fa-solid fa-code-branch"></i><span class="rs_bchip_num"></span></span>');
    $chip.find('.rs_bchip_num').text(list.length + 1);
    $chip.attr('data-id', id);
}

function branchLabel(file) {
    const m = String(file).match(/^(?:Branch|Checkpoint) #\d+ - (.+)$/);
    return m ? m[1].replace(/@(\d+)h(\d+)m.*$/, ' $1:$2') : file;
}

function openBranchMenu(id, anchor) {
    closeVersionMenu();
    const list = branchInfo?.groups.get(id) || [];
    const pv = t => previewText(t, VERSION_PREVIEW);
    const lastMes = ctx().chat[ctx().chat.length - 1];
    const rows = [
        `<div class="rs_vmenu_item rs_on"><div class="rs_vmenu_no">当前这条线　${escapeHtml(branchLabel(branchInfo.cur))}</div><div class="rs_vmenu_pv">${escapeHtml(pv(lastMes?.mes ?? ''))}</div></div>`,
        ...list.map(x => `<div class="rs_vmenu_item" data-file="${escapeHtml(x.file)}"><div class="rs_vmenu_no">${x.rel}　${escapeHtml(branchLabel(x.file))}</div><div class="rs_vmenu_pv">${escapeHtml(pv(x.last))}</div></div>`),
    ].join('');
    placeMenu($(`<div id="rs_vmenu" data-branch="${id}">${rows}</div>`).appendTo('body'), anchor);
}

async function openBranch(file) {
    closeVersionMenu();
    if (isDirty() && !(await askConfirm('面板里有没保存的修改，切换分支会关掉面板，继续吗？'))) return;
    if ($('#rs_overlay').length) await closePanel(true, true);
    let open = ctx().openCharacterChat;
    if (typeof open !== 'function') {
        try {
            open = (await import('/script.js')).openCharacterChat;
        } catch { }
    }
    if (typeof open !== 'function') {
        toastr.error('这个版本的酒馆不支持直接切换，请到聊天记录里打开');
        return;
    }
    await open(file);
}

async function switchVersion(id, i) {
    const c = ctx();
    const m = c.chat[id];
    const n = versionCount(m);
    if (n < 2) return;
    i = ((i % n) + n) % n;
    const cur = Number.isInteger(m.swipe_id) ? m.swipe_id : 0;
    if (i === cur) return;
    m.swipes[cur] = m.mes;
    m.swipe_id = i;
    m.mes = m.swipes[i];
    const info = Array.isArray(m.swipe_info) ? m.swipe_info[i] : null;
    if (info?.extra) m.extra = structuredClone(info.extra);
    if (info?.send_date) m.send_date = info.send_date;
    c.updateMessageBlock(id, m);
    refreshSwipeUI(id, m);
    await c.saveChat();
}

function openVersionMenu(id, anchor) {
    closeVersionMenu();
    const m = ctx().chat[id];
    const cur = Number.isInteger(m.swipe_id) ? m.swipe_id : 0;
    const items = m.swipes.map((t, i) => {
        const pv = previewText(i === cur ? m.mes : t, VERSION_PREVIEW);
        return `<div class="rs_vmenu_item ${i === cur ? 'rs_on' : ''}" data-i="${i}"><div class="rs_vmenu_no">版本 ${i + 1}${i === cur ? '　当前' : ''}</div><div class="rs_vmenu_pv">${escapeHtml(pv)}</div></div>`;
    }).join('');
    placeMenu($(`<div id="rs_vmenu" data-id="${id}">${items}</div>`).appendTo('body'), anchor);
}

function placeMenu($m, anchor) {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    const below = window.innerHeight - r.bottom;
    $m.css({ left: left + 'px', width: w + 'px' });
    if (below > 220 || below > r.top) $m.css({ top: r.bottom + 6 + 'px', maxHeight: below - 16 + 'px' });
    else $m.css({ bottom: window.innerHeight - r.top + 6 + 'px', maxHeight: r.top - 16 + 'px' });
}

function closeVersionMenu() {
    $('#rs_vmenu').remove();
}

const TAP_SKIP = 'a, button, input, textarea, select, summary, details, img, video, audio, iframe, label, .rs_vchip, .rs_bchip, .mes_buttons, .mes_edit_buttons, .swipe_left, .swipe_right';
let tap = null;

function textPosAt(x, y) {
    if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

function nodeAtOffset(root, off) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    let last = null;
    while ((n = walker.nextNode())) {
        if (off <= n.length) return { node: n, offset: off };
        off -= n.length;
        last = n;
    }
    return last ? { node: last, offset: last.length } : null;
}

function rangeOf(root, a, b) {
    const s0 = nodeAtOffset(root, a);
    const s1 = nodeAtOffset(root, b);
    if (!s0 || !s1) return null;
    const r = document.createRange();
    r.setStart(s0.node, s0.offset);
    r.setEnd(s1.node, s1.offset);
    return r;
}

function countOf(hay, needle) {
    let n = 0;
    let i = hay.indexOf(needle);
    while (i >= 0) {
        n++;
        i = hay.indexOf(needle, i + needle.length);
    }
    return n;
}

function sentenceAtTap(e, textEl) {
    const pos = textPosAt(e.clientX, e.clientY);
    if (!pos || pos.node.nodeType !== Node.TEXT_NODE || !textEl.contains(pos.node)) return null;
    const block = pos.node.parentElement.closest('p, li, blockquote, h1, h2, h3, h4, h5, h6, div') || textEl;
    const scope = textEl.contains(block) ? block : textEl;
    const pre = document.createRange();
    pre.setStart(scope, 0);
    pre.setEnd(pos.node, pos.offset);
    const at = pre.toString().length;
    const full = scope.textContent;
    let found = null;
    eachSentence(full, (sen, a, b) => {
        if (!found && at >= a && at < b && sen.trim()) found = { a, b, sen };
    });
    if (!found) return null;
    const lead = found.sen.length - found.sen.trimStart().length;
    const tail = found.sen.length - found.sen.trimEnd().length;
    const a = found.a + lead;
    const b = found.b - tail;
    const sentence = full.slice(a, b);
    const before = document.createRange();
    before.setStart(textEl, 0);
    const startPos = nodeAtOffset(scope, a);
    before.setEnd(startPos.node, startPos.offset);
    return {
        sentence,
        nth: countOf(before.toString(), sentence),
        range: rangeOf(scope, a, b),
    };
}

function locateInRaw(raw, sentence, nth) {
    const d = readerDisplay(raw, { hide: '', body: '', code: false, md: true });
    const squash = t => t.replace(/\s+/g, '');
    const target = squash(sentence);
    if (!target) return null;
    const keep = [];
    let plain = '';
    for (let i = 0; i < d.text.length; i++) {
        if (/\s/.test(d.text[i])) continue;
        plain += d.text[i];
        keep.push(d.map[i]);
    }
    const hits = [];
    let i = plain.indexOf(target);
    while (i >= 0) {
        hits.push(i);
        i = plain.indexOf(target, i + target.length);
    }
    if (!hits.length) return null;
    const k = hits[Math.min(nth, hits.length - 1)];
    return [keep[k], keep[k + target.length - 1] + 1];
}

const INLINE_UNDO_PAUSE = 600;

function endInlineEdit(restore) {
    if (!tap) return;
    clearTimeout(tap.timer);
    if (restore && tap.box?.isConnected) tap.box.replaceWith(tap.frag);
    else tap.box?.remove();
    tap = null;
}

function inlineSnap() {
    clearTimeout(tap.timer);
    const ta = tap.ta;
    const last = tap.undo[tap.undo.length - 1];
    if (last?.v === ta.value) return;
    tap.undo.push({ v: ta.value, s: ta.selectionStart, e: ta.selectionEnd });
    tap.redo = [];
    updateInlineButtons();
}

function updateInlineButtons() {
    if (!tap) return;
    const dirtyUndo = tap.undo.length > 1 || tap.ta.value !== tap.undo[0].v;
    $(tap.box).find('[data-act="undo"]').toggleClass('rs_off', !dirtyUndo);
    $(tap.box).find('[data-act="redo"]').toggleClass('rs_off', !tap.redo.length);
}

function inlineUndo() {
    if (tap.ta.value !== tap.undo[tap.undo.length - 1].v) inlineSnap();
    if (tap.undo.length < 2) return;
    tap.redo.push(tap.undo.pop());
    applyInline(tap.undo[tap.undo.length - 1]);
}

function inlineRedo() {
    const sn = tap.redo.pop();
    if (!sn) return;
    tap.undo.push(sn);
    applyInline(sn);
}

function applyInline(sn) {
    const ta = tap.ta;
    ta.value = sn.v;
    ta.focus();
    ta.setSelectionRange(sn.s, sn.e);
    fitInline();
    updateInlineButtons();
}

function fitInline() {
    const ta = tap?.ta;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
}

const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_DIST = 30;
let lastTap = null;

function onMessageClick(e) {
    if (!settings().tapEdit) return;
    if ($(e.target).closest('.rs_inline_box').length || $(e.target).closest(TAP_SKIP).length) return;
    const now = Date.now();
    const prev = lastTap;
    lastTap = { t: now, x: e.clientX, y: e.clientY, el: e.currentTarget };
    if (!prev || prev.el !== e.currentTarget || now - prev.t > DOUBLE_TAP_MS || Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > DOUBLE_TAP_DIST) return;
    lastTap = null;
    window.getSelection()?.removeAllRanges();
    onMessageTap(e);
}

function keepInView() {
    const box = tap?.box;
    const chat = document.getElementById('chat');
    if (!box?.isConnected || !chat) return;
    const vv = window.visualViewport;
    const viewTop = Math.max(chat.getBoundingClientRect().top, vv ? vv.offsetTop : 0);
    const viewBottom = Math.min(chat.getBoundingClientRect().bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
    const r = box.getBoundingClientRect();
    if (r.top < viewTop + 8) chat.scrollTop -= viewTop + 8 - r.top;
    else if (r.bottom > viewBottom - 8) chat.scrollTop += Math.min(r.bottom - viewBottom + 8, r.top - viewTop - 8);
}

function onMessageTap(e) {
    const textEl = e.currentTarget;
    if (textEl.querySelector('textarea:not(.rs_inline_ta)')) return;
    if (tap) {
        if (tap.ta.value !== tap.original) return;
        endInlineEdit(true);
    }
    const mes = textEl.closest('.mes');
    const id = Number(mes?.getAttribute('mesid'));
    const m = ctx().chat[id];
    if (!Number.isInteger(id) || !m) return;
    const hit = sentenceAtTap(e, textEl);
    if (!hit) return;
    const span = hit.range && locateInRaw(m.mes, hit.sentence, hit.nth);
    if (!span) {
        toastr.info('这句被正则改过显示，对不上原文，请用整楼编辑');
        return;
    }
    const [a, b] = span;
    const original = m.mes.slice(a, b);

    const $box = $(`
<div class="rs_inline_box">
  <div class="rs_inline_tools">
    <div class="rs_inline_btn fa-solid fa-object-group" data-act="all" title="全选"></div>
    <div class="rs_inline_btn fa-solid fa-copy" data-act="copy" title="复制"></div>
    <div class="rs_inline_btn fa-solid fa-rotate-left" data-act="undo" title="撤回"></div>
    <div class="rs_inline_btn fa-solid fa-rotate-right" data-act="redo" title="重做"></div>
    <div class="rs_inline_btn fa-solid fa-xmark" data-act="cancel" title="取消"></div>
    <div class="rs_inline_btn rs_inline_ok fa-solid fa-check" data-act="ok" title="确认"></div>
  </div>
  <textarea class="rs_inline_ta" spellcheck="false"></textarea>
</div>`);
    const chat = document.getElementById('chat');
    const keep = chat?.scrollTop;
    const frag = hit.range.extractContents();
    hit.range.insertNode($box[0]);
    const ta = $box.find('.rs_inline_ta')[0];
    ta.value = original;
    tap = { id, a, b, raw: m.mes, original, ta, box: $box[0], frag, undo: [{ v: original, s: original.length, e: original.length }], redo: [], timer: 0 };
    fitInline();
    updateInlineButtons();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(original.length, original.length);
    if (chat) chat.scrollTop = keep;
    requestAnimationFrame(() => {
        if (chat) chat.scrollTop = keep;
        keepInView();
    });
    setTimeout(keepInView, 400);
}

async function confirmInlineEdit() {
    const t = tap;
    if (!t) return;
    const c = ctx();
    const m = c.chat[t.id];
    const piece = t.ta.value;
    if (!m || m.mes !== t.raw) {
        endInlineEdit(true);
        toastr.warning('这一楼已经变了，没有保存');
        return;
    }
    endInlineEdit(piece === t.original);
    if (piece === t.original) return;
    let text = m.mes.slice(0, t.a) + piece + m.mes.slice(t.b);
    if (!piece.trim()) text = text.replace(/\n[ \t]*\n[ \t]*\n/g, '\n\n');
    setFloorText(t.id, text);
    await c.saveChat();
    toastr.success('已保存，点这里撤回', '', {
        onclick: async () => {
            const mm = ctx().chat[t.id];
            if (!mm || mm.mes !== text) return;
            setFloorText(t.id, t.raw);
            await ctx().saveChat();
            toastr.info('已撤回');
        },
    });
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

const ALT_PREVIEW = 14;

async function postCharUpdate(body) {
    const res = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!res.ok) toastr.error('保存角色卡失败');
    return res.ok;
}

async function savedTarget(key, initial, rest) {
    return { refs: await buildRefs(key, initial), key, ref: 0, initial, saveLabel: '保存', closeAfterSave: false, ...rest };
}

async function charTarget(field = 'description') {
    const ch = currentChar();
    if (!ch) {
        toastr.warning('先打开一个角色的单人聊天');
        return null;
    }
    const alts = Array.isArray(ch.data?.alternate_greetings) ? ch.data.alternate_greetings : [];
    const altMatch = String(field).match(/^alt:(\d+|new)$/);
    const altIndex = altMatch ? (altMatch[1] === 'new' ? alts.length : Number(altMatch[1])) : -1;
    const isAlt = altIndex >= 0 && altIndex <= alts.length;
    const def = isAlt ? null : CHAR_FIELDS.find(f => f[0] === field) || CHAR_FIELDS[0];
    if (!isAlt) field = def[0];
    else field = altIndex === alts.length ? 'alt:new' : `alt:${altIndex}`;

    const initial = isAlt
        ? String(alts[altIndex] ?? '')
        : String((def[3] ? ch.data?.[def[0]] : ch[def[0]] ?? ch.data?.[def[0]]) ?? '');
    const key = isAlt ? (field === 'alt:new' ? null : `char:${ch.avatar}:alt:${altIndex}`) : `char:${ch.avatar}:${def[0]}`;

    const preview = t => previewText(t, ALT_PREVIEW);
    const opts = [
        ...CHAR_FIELDS.map(([k, label]) => `<option value="${k}" ${k === field ? 'selected' : ''}>${label}</option>`),
        `<optgroup label="备选开场白（${alts.length}）">`,
        ...alts.map((t, i) => `<option value="alt:${i}" ${field === `alt:${i}` ? 'selected' : ''}>备选 ${i + 1}：${escapeHtml(preview(t))}</option>`),
        `<option value="alt:new" ${field === 'alt:new' ? 'selected' : ''}>＋ 新建备选开场白</option>`,
        '</optgroup>',
    ].join('');

    return savedTarget(key, initial, {
        kind: 'char',
        field,
        subtitle: escapeHtml(ch.name),
        pickers: `<select class="rs_pick text_pole" data-pick="char">${opts}</select>`,
        saveLabel: field === 'alt:new' ? '新建' : '保存',
        save: async function (text) {
            if (isAlt) {
                const list = [...(Array.isArray(ch.data?.alternate_greetings) ? ch.data.alternate_greetings : [])];
                list[altIndex] = text;
                if (!(await postCharUpdate({ avatar: ch.avatar, data: { alternate_greetings: list } }))) return false;
                ch.data = ch.data || {};
                ch.data.alternate_greetings = list;
                if (field === 'alt:new') {
                    this.field = `alt:${altIndex}`;
                    toastr.success(`已新建备选开场白 ${altIndex + 1}`);
                    return true;
                }
                await addSnaps(key, initial, text);
                toastr.success(`备选开场白 ${altIndex + 1} 已保存`);
                return true;
            }
            const [f, , selector, dataOnly] = def;
            const body = { avatar: ch.avatar, data: { [f]: text } };
            if (!dataOnly) body[f] = text;
            if (!(await postCharUpdate(body))) return false;
            ch.data = ch.data || {};
            ch.data[f] = text;
            if (!dataOnly) ch[f] = text;
            if (selector) $(selector).val(text);
            await addSnaps(key, initial, text);
            toastr.success('角色卡已保存');
            return true;
        },
    });
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
    return savedTarget(key, initial, {
        kind: 'persona',
        subtitle: escapeHtml(c.name1),
        pickers: '',
        save: async text => {
            $('#persona_description').val(text).trigger('input');
            await addSnaps(key, initial, text);
            toastr.success('用户人设已保存');
            return true;
        },
    });
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
            kind: 'world',
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

    return savedTarget(key, initial, {
        kind: 'world',
        pickers: `<select class="rs_pick text_pole" data-pick="book">${bookOpts}</select>
<select class="rs_pick text_pole" data-pick="entry">${entryOpts}</select>
${wiToggleHtml(!entry.disable)}`,
        book,
        uid: entry.uid,
        save: async text => {
            const fresh = await ctx().loadWorldInfo(book);
            if (!fresh?.entries?.[entry.uid]) {
                toastr.error('这个条目已经不存在了');
                return false;
            }
            fresh.entries[entry.uid].content = text;
            await ctx().saveWorldInfo(book, fresh, true);
            try { ctx().reloadWorldInfoEditor?.(book, false); } catch { }
            await addSnaps(key, initial, text);
            toastr.success('世界书条目已保存');
            return true;
        },
    });
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
    try { c.reloadWorldInfoEditor?.(t.book, false); } catch { }

    const on = !entry.disable;
    $('#rs_panel .rs_wi_toggle').replaceWith(wiToggleHtml(on));
    const $opt = $(`#rs_panel .rs_pick[data-pick="entry"] option[value="${t.uid}"]`);
    $opt.text($opt.text().replace(/（已禁用）$/, '') + (on ? '' : '（已禁用）'));
    toastr.success(on ? '条目已启用' : '条目已禁用');
}

const CLICHE_GAP = '[^。！？!?\\n]{0,40}?';

let clicheCache = { src: null, re: null, entries: [] };
const escapeRe = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function clicheRegex() {
    const src = String(settings().clicheWords || '');
    if (clicheCache.src === src) return clicheCache.re;
    const parts = [];
    const entries = [];
    src.split(/\n/).map(x => x.trim()).filter(Boolean).forEach(line => {
        const arrow = line.match(/^(.*?)\s*(?:→|=>)\s*(.*)$/);
        const w = arrow ? arrow[1].trim() : line;
        const to = arrow ? arrow[2] : null;
        if (!w) return;
        let pattern;
        const m = w.match(/^\/(.+)\/$/);
        if (m) {
            try {
                new RegExp(m[1]);
                pattern = m[1];
            } catch {
                console.warn('[重生成拼接] 八股词正则写错了，已跳过：', w);
                return;
            }
        } else {
            pattern = w.split(/…+|\*/).map(escapeRe).join(CLICHE_GAP);
        }
        parts.push(`(?<c${entries.length}>${pattern})`);
        entries.push({ pattern, to });
    });
    clicheCache = { src, re: parts.length ? new RegExp(parts.join('|'), 'g') : null, entries };
    return clicheCache.re;
}

const clicheActive = () => state.target?.kind === 'msg' && settings().clicheOn && !!clicheRegex();

function clicheHits(text) {
    const re = clicheRegex();
    if (!re) return [];
    const hits = [];
    eachMatch(re, text, m => {
        const k = Object.keys(m.groups).find(g => /^c\d+$/.test(g) && m.groups[g] !== undefined);
        hits.push({ a: m.index, b: m.index + m[0].length, entry: clicheCache.entries[Number(k.slice(1))] });
    });
    return hits;
}

function clicheRanges(text) {
    const words = clicheHits(text).map(h => [h.a, h.b]);
    if (!settings().clicheWhole || !words.length) return words;

    const out = [];
    eachSentence(text, (sen, a, b) => {
        if (words.some(([x, y]) => x < b && y > a)) out.push([a, b]);
    });
    return out;
}

function fixAllCliche() {
    const ta = bodyEl();
    if (ta.readOnly) return;
    const text = ta.value;
    const hits = clicheHits(text);
    if (!hits.length) {
        toastr.info('正文里没有八股词');
        return;
    }
    const ops = [];
    let replaced = 0;
    let removed = 0;
    if (settings().clicheWhole) {
        eachSentence(text, (sen, a, b) => {
            if (hits.some(h => h.entry.to === null && h.a < b && h.b > a)) ops.push([a, b, '']);
        });
        removed = ops.length;
    }
    hits.forEach(h => {
        if (ops.some(([a, b]) => h.a < b && h.b > a)) return;
        if (h.entry.to === null) {
            ops.push([h.a, h.b, '']);
            removed++;
        } else {
            ops.push([h.a, h.b, text.slice(h.a, h.b).replace(new RegExp(h.entry.pattern), h.entry.to)]);
            replaced++;
        }
    });
    ops.sort((x, y) => y[0] - x[0]);
    let out = text;
    ops.forEach(([a, b, to]) => { out = out.slice(0, a) + to + out.slice(b); });
    out = out.split('\n').filter((line, i, arr) => line.trim() || !(text.split('\n')[i]?.trim())).join('\n');
    setBody(out, 0);
    const what = settings().clicheWhole ? '句' : '处';
    toastr.success([removed && `删掉 ${removed} ${what}`, replaced && `替换 ${replaced} 处`].filter(Boolean).join('，') + '，可以撤销');
}

function markRanges(text, ranges, cls) {
    let html = '';
    let last = 0;
    ranges.forEach(([a, b]) => {
        html += escapeHtml(text.slice(last, a)) + `<mark class="${cls}">${escapeHtml(text.slice(a, b))}</mark>`;
        last = b;
    });
    return html + escapeHtml(text.slice(last));
}

function markCliche(text) {
    const ranges = clicheRanges(text);
    return { html: markRanges(text, ranges, 'rs_mark'), count: ranges.length };
}

function renderBack() {
    const ta = bodyEl();
    const $back = $('#rs_panel .rs_body_back');
    const $btn = $('#rs_panel .rs_cliche');
    if (!ta || !$back.length) return;
    const text = ta.value;
    const isMsg = state.target?.kind === 'msg';

    $btn.toggle(isMsg);
    $('#rs_panel .rs_cliche_set').toggle(isMsg);
    $('#rs_panel .rs_bodyonly').toggle(isMsg && (state.target.bodyOnly || !settings().editBodyOnly))
        .text(settings().editBodyOnly ? '仅正文' : '全文')
        .toggleClass('rs_on', !!settings().editBodyOnly);
    if (!isMsg) {
        $('#rs_panel .rs_cliche_box').hide();
        $('#rs_panel .rs_cliche_set').removeClass('rs_on');
    }
    const cliche = isMsg && clicheActive() ? clicheRanges(text) : null;
    if (cliche) $btn.text(`八股 ${cliche.length}`).addClass('rs_on').toggleClass('rs_hit', cliche.length > 0);
    else $btn.text('八股 关').removeClass('rs_on rs_hit');

    const find = boxOpen('find') ? findRanges(text) : null;
    if (find) updateFindInfo(find.length);

    let ranges = [];
    let cls = '';
    if (find?.length) {
        [ranges, cls] = [find, 'rs_find'];
    } else if (cliche) {
        [ranges, cls] = [cliche, 'rs_mark'];
    } else if (!isMsg && state.diff) {
        const refText = state.target.refs[state.ref]?.text ?? '';
        if (refText.trim()) [ranges, cls] = [addedRanges(text, sentenceSet(refText)), 'rs_add'];
    }
    const caret = state.caret ? Math.min(state.caret.s, text.length) : text.length;
    $back.html(backHtml(text, ranges, cls, caret) + (text.endsWith('\n') ? '\u200b' : ''));
    syncBackScroll();
}

const CARET_HTML = '<span class="rs_caret"></span>';
function backHtml(text, ranges, cls, caret) {
    let html = '';
    let done = false;
    const piece = (a, b) => {
        if (!done && caret >= a && caret <= b) {
            done = true;
            return escapeHtml(text.slice(a, caret)) + CARET_HTML + escapeHtml(text.slice(caret, b));
        }
        return escapeHtml(text.slice(a, b));
    };
    let last = 0;
    ranges.forEach(([a, b]) => {
        html += piece(last, a) + `<mark class="${cls}">${piece(a, b)}</mark>`;
        last = b;
    });
    html += piece(last, text.length);
    return html;
}

const findQuery = () => String($('#rs_panel .rs_find_q').val() ?? '');
const findReplacement = () => String($('#rs_panel .rs_find_r').val() ?? '');


function excludedSpans(text) {
    const spans = [];
    tagNames(settings().findExclude).forEach(name => eachMatch(tagBlockRe(name), text, m => spans.push([m.index, m.index + m[0].length])));
    return spans;
}

function findRanges(text) {
    const q = findQuery();
    const out = [];
    if (!q) return out;
    const skip = excludedSpans(text);
    let i = text.indexOf(q);
    while (i >= 0) {
        const end = i + q.length;
        if (!skip.some(([a, b]) => i < b && end > a)) out.push([i, end]);
        i = text.indexOf(q, end);
    }
    return out;
}

function updateFindInfo(count) {
    $('#rs_panel .rs_find_box .rs_find_info').text(findQuery() ? `${count} 处` : '');
}

function selectHit(hits, i) {
    const ta = bodyEl();
    const [a, b] = hits[i];
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(a, b);
    state.caret = { s: a, e: b };
    const scrollToHit = () => {
        const mark = $('#rs_panel .rs_body_back mark')[i];
        if (mark) ta.scrollTop = Math.max(0, mark.offsetTop - ta.clientHeight / 3);
        syncBackScroll();
    };
    scrollToHit();
    setTimeout(scrollToHit, 400);
}

function nextIndex(hits) {
    const from = state.caret ? state.caret.e : 0;
    const i = hits.findIndex(h => h[0] >= from);
    return i < 0 ? 0 : i;
}

function findNext() {
    const hits = findRanges(bodyEl().value);
    if (!hits.length) {
        toastr.info('没有找到');
        return;
    }
    selectHit(hits, nextIndex(hits));
}

function setBody(value, caretPos) {
    const ta = bodyEl();
    state.typing = false;
    pushUndo();
    ta.value = value;
    const pos = Math.min(caretPos, value.length);
    try { ta.setSelectionRange(pos, pos); } catch { }
    state.caret = { s: pos, e: pos };
    state.last = snap();
    updateUndoButtons();
    afterEdit();
    if (state.diff) renderRef();
}

function replaceOne() {
    const ta = bodyEl();
    if (ta.readOnly) return;
    const hits = findRanges(ta.value);
    const sel = state.caret || { s: -1, e: -1 };
    const hit = hits.find(([a, b]) => a === sel.s && b === sel.e);
    if (!hit) {
        findNext();
        return;
    }
    const piece = findReplacement();
    setBody(ta.value.slice(0, hit[0]) + piece + ta.value.slice(hit[1]), hit[0] + piece.length);
    findNext();
}

function replaceAll() {
    const ta = bodyEl();
    if (ta.readOnly) return;
    const hits = findRanges(ta.value);
    if (!hits.length) {
        toastr.info('没有找到');
        return;
    }
    const rep = findReplacement();
    let out = '';
    let last = 0;
    hits.forEach(([a, b]) => {
        out += ta.value.slice(last, a) + rep;
        last = b;
    });
    setBody(out + ta.value.slice(last), 0);
    toastr.success(`已替换 ${hits.length} 处，可以撤销`);
}

const BOXES = {
    find: ['.rs_find_box', '.rs_find_btn'],
    cliche: ['.rs_cliche_box', '.rs_cliche_set'],
    lib: ['.rs_lib_box', '.rs_lib_btn'],
};
const boxOpen = which => $(`#rs_panel ${BOXES[which][0]}`).is(':visible');

function toggleBox(which) {
    const willOpen = !boxOpen(which);
    for (const [k, [box, btn]] of Object.entries(BOXES)) {
        const on = k === which && willOpen;
        $(`#rs_panel ${box}`).toggle(on);
        $(`#rs_panel ${btn}`).toggleClass('rs_on', on);
    }
    if (which === 'find' && willOpen) $('#rs_panel .rs_find_q').trigger('focus');
    if (which === 'lib' && willOpen) renderLib();
    renderBack();
}

function sourceLabel(where) {
    const t = state.target;
    if (!t) return '';
    const kind = { msg: '楼层', char: '角色卡', persona: '人设', world: '世界书' }[t.kind] || '';
    return [kind, t.subtitle?.replace(/<[^>]+>/g, ''), where ?? t.refs?.[state.ref]?.label].filter(Boolean).join(' ');
}

async function collect(text, from) {
    text = String(text).trim();
    if (!text) {
        toastr.warning('没有可收藏的文字');
        return;
    }
    let lib = await getLib();
    if (lib.some(x => x.text === text)) {
        toastr.info('素材库里已经有这句了');
        return;
    }
    lib.unshift({ id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, from, time: Date.now() });
    const max = Math.max(10, parseInt(settings().libMax) || DEFAULTS.libMax);
    if (lib.length > max) lib = lib.slice(0, max);
    await putLib(lib);
    toastr.success('已收进素材库');
    if (boxOpen('lib')) renderLib();
}

async function renderLib() {
    const q = String($('#rs_panel .rs_lib_q').val() ?? '').trim();
    const lib = (await getLib()).filter(x => !q || x.text.includes(q));
    $('#rs_panel .rs_lib_list').html(lib.length
        ? lib.map(x => `
<div class="rs_lib_item" data-id="${x.id}">
  <div class="rs_lib_main">
    <div class="rs_lib_text">${escapeHtml(x.text)}</div>
    <div class="rs_lib_meta">${escapeHtml(x.from || '')} ${fmtTime(x.time)}</div>
  </div>
  <div class="rs_icon rs_lib_del fa-solid fa-xmark" title="删除"></div>
</div>`).join('')
        : `<div class="rs_empty">${q ? '没有找到' : '还没有素材。在参考区点选句子后点「收藏」，或者在正文里选中文字后点「收藏选中」。'}</div>`);
}

async function useLibItem(id) {
    const item = (await getLib()).find(x => x.id === id);
    if (item) insertSentence(item.text);
}

async function deleteLibItem(id) {
    await putLib((await getLib()).filter(x => x.id !== id));
    renderLib();
}

function collectSelection() {
    const ta = bodyEl();
    const sel = state.caret && state.caret.e > state.caret.s ? ta.value.slice(state.caret.s, state.caret.e) : '';
    if (!sel.trim()) {
        toastr.info('先在正文里选中一段文字');
        return;
    }
    collect(sel, sourceLabel('正文'));
}

let sel = null;

function selSpans() {
    if (!sel) return $();
    return $(sel.box).find(`.rs_s[data-g="${sel.g}"]`).filter(function () {
        const i = Number(this.dataset.i);
        return i >= sel.a && i <= sel.b;
    });
}

function clearSel() {
    if (!sel) return;
    $(sel.box).find('.rs_s.rs_sel').removeClass('rs_sel');
    $(sel.box).find('.rs_tb').remove();
    sel = null;
}

function onSentenceTap(el) {
    const box = el.closest('.rs_ref_pane, .rs_reader_body');
    const g = el.dataset.g;
    const i = Number(el.dataset.i);
    if (!sel || sel.box !== box || sel.g !== g || i < sel.a - 1 || i > sel.b + 1) {
        clearSel();
        sel = { box, g, a: i, b: i };
    } else if (i === sel.a - 1) {
        sel.a = i;
    } else if (i === sel.b + 1) {
        sel.b = i;
    } else if (sel.a === sel.b) {
        clearSel();
        return;
    } else if (i === sel.a) {
        sel.a++;
    } else if (i === sel.b) {
        sel.b--;
    } else {
        sel.a = sel.b = i;
    }
    $(box).find('.rs_s.rs_sel').removeClass('rs_sel');
    selSpans().addClass('rs_sel');
    placeToolbar();
}

function placeToolbar() {
    const $box = $(sel.box);
    $box.find('.rs_tb').remove();
    const isReader = $box.hasClass('rs_reader_body');
    const btns = isReader
        ? [['fav', '收藏'], ['copy', '复制'], ['edit', '编辑这楼']]
        : [['ins', '插入'], ['fav', '收藏'], ['copy', '复制']];
    $box.append(`<div class="rs_tb">${btns.map(([k, t]) => `<div class="rs_tb_btn" data-act="${k}">${t}</div>`).join('')}</div>`);
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

function onToolbarAct(act) {
    const spans = selSpans();
    const text = spans.map((_, e) => e.textContent).get().join('');
    const isReader = $(sel.box).hasClass('rs_reader_body');
    const floor = isReader ? Number(spans.first().closest('.rs_floor').data('id')) : null;
    if (act === 'ins') {
        spans.each((_, e) => state.used.add(e.dataset.k));
        clearSel();
        insertSentence(text);
        return;
    }
    if (act === 'fav') collect(text, isReader ? `阅读 第 ${floor} 楼` : sourceLabel());
    if (act === 'copy') copyText(text);
    clearSel();
    if (act === 'edit') switchTarget(async () => msgTarget(floor));
}

const READER_CHUNK = 30;
const reader = { from: 0, hits: [], cur: -1, undo: [] };

const tagNames = str => String(str || '').split(/[\s,，、]+/).map(x => x.replace(/[<>/]/g, '').trim()).filter(x => /^[\w-]+$/.test(x));

const READER_PRESETS = {
    paper: { name: '米白', bg: '#f5f4ee', text: '#262626', quote: '#4f7d4a', italic: '#5a5a5a', muted: '#9b9a92' },
    sage: { name: '青绿', bg: '#d4ddd0', text: '#1f2d3b', quote: '#477443', italic: '#4b5a55', muted: '#7b8a80' },
    dark: { name: '夜黑', bg: '#1c1c21', text: '#ece3cc', quote: '#d4b26a', italic: '#b9b3a5', muted: '#8d877a' },
    navy: { name: '藏蓝', bg: '#232f78', text: '#eef0fb', quote: '#ffffff', italic: '#a9b3e6', muted: '#8a94cf' },
};
const COLOR_KEYS = [['bg', '底色'], ['text', '正文'], ['quote', '对话'], ['italic', '斜体'], ['muted', '次要']];

function readerDisplay(raw, opt = {}) {
    raw = String(raw ?? '');
    const o = {
        hide: settings().readerHide,
        body: settings().readerBody,
        code: settings().readerHideCode,
        md: settings().readerMarkdown,
        ...opt,
    };
    const gone = new Uint8Array(raw.length);
    const cut = re => eachMatch(re, raw, m => gone.fill(1, m.index, m.index + m[0].length));
    tagNames(o.hide).forEach(n => cut(tagBlockRe(n)));
    const body = tagNames(o.body)[0];
    if (body) {
        const keep = [];
        eachMatch(tagBlockRe(body, 'gid'), raw, m => keep.push(m.indices[1]));
        if (keep.length) {
            const outside = new Uint8Array(raw.length).fill(1);
            keep.forEach(([a, b]) => outside.fill(0, a, b));
            outside.forEach((v, j) => { if (v) gone[j] = 1; });
        }
    }
    if (o.code) cut(/```[\s\S]*?(?:```|$)/g);
    cut(/<\/?[A-Za-z_][\w-]*(?:\s[^>]*)?\/?>/g);

    let text = '';
    const map = [];
    const fmt = [];
    const shown = new Uint8Array(raw.length);
    const md = o.md;
    let f = 0;
    for (let j = 0; j < raw.length; j++) {
        if (gone[j]) continue;
        if (md) {
            if (raw.startsWith('**', j)) {
                f ^= 2;
                j++;
                continue;
            }
            if (raw.startsWith('~~', j)) {
                f ^= 4;
                j++;
                continue;
            }
            if (raw[j] === '*') {
                f ^= 1;
                continue;
            }
        }
        if (raw[j] === '\n') f = 0;
        text += raw[j];
        map.push(j);
        fmt.push(f);
        shown[j] = 1;
    }
    return { text, map, fmt, shown };
}

function floorAvatar(m) {
    if (m.force_avatar) return m.force_avatar;
    const ch = !m.is_user && currentChar();
    return ch?.avatar ? `/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}` : '';
}

function floorTime(m) {
    const t = m.send_date;
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d)) return String(t);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const QUOTE_OPEN = '“「『"';
const QUOTE_CLOSE = '”」』"';

function floorHtml(id) {
    const m = ctx().chat[id];
    if (!m) return '';
    const d = readerDisplay(m.mes);
    const hitAt = new Int32Array(d.text.length).fill(-1);
    reader.hits.forEach((h, hi) => {
        if (h.id !== id) return;
        d.map.forEach((rawPos, i) => {
            if (rawPos >= h.a && rawPos < h.b) hitAt[i] = hi;
        });
    });

    let body = '';
    let off = 0;
    d.text.split('\n').forEach((line, pi) => {
        if (line.trim()) {
            let inQuote = false;
            let pos = off;
            const quoteOn = settings().readerQuote;
            const spans = splitSentences(line).map((sen, si) => {
                let html = '';
                let runKey = null;
                let run = '';
                const flush = () => {
                    if (!run) return;
                    const [q, f, h] = runKey.split('|');
                    const cls = [q === '1' && 'rs_rq', f & 1 && 'rs_ri', f & 2 && 'rs_rb', f & 4 && 'rs_rs', h !== '-1' && 'rs_rhit'].filter(Boolean).join(' ');
                    html += cls ? `<span class="${cls}"${h !== '-1' ? ` data-h="${h}"` : ''}>${escapeHtml(run)}</span>` : escapeHtml(run);
                    run = '';
                };
                for (let k = 0; k < sen.length; k++) {
                    const ch = sen[k];
                    const idx = pos + k;
                    let q = inQuote;
                    if (!inQuote && QUOTE_OPEN.includes(ch)) inQuote = q = true;
                    else if (inQuote && QUOTE_CLOSE.includes(ch)) inQuote = false;
                    const key = `${q && quoteOn ? 1 : 0}|${d.fmt[idx]}|${hitAt[idx]}`;
                    if (key !== runKey) {
                        flush();
                        runKey = key;
                    }
                    run += ch;
                }
                flush();
                pos += sen.length;
                return `<span class="rs_s" data-g="${id}-${pi}" data-i="${si}">${html}</span>`;
            }).join('');
            body += `<p>${spans}</p>`;
        }
        off += line.length + 1;
    });

    const s = settings();
    const av = floorAvatar(m);
    const initial = escapeHtml((m.name || '?').slice(0, 1));
    const time = s.readerShowTime ? floorTime(m) : '';
    const book = String(s.readerBook || '').trim();
    const sign = String(s.readerSign || '').trim();
    return `
<section class="rs_floor ${m.is_system ? 'rs_floor_hidden' : ''}" data-id="${id}">
  <div class="rs_floor_head">
    ${av ? `<img class="rs_floor_av" src="${escapeHtml(av)}" alt="" loading="lazy">` : ''}
    <div class="rs_floor_av rs_floor_av_none"${av ? ' hidden' : ''}>${initial}</div>
    <div class="rs_floor_name">${escapeHtml(m.name || '')}${m.is_system ? '<span class="rs_floor_tag">已隐藏</span>' : ''}</div>
    <div class="rs_floor_meta">第 ${id} 楼${time ? `　${escapeHtml(time)}` : ''}</div>
  </div>
  <div class="rs_floor_text">${body || '<p class="rs_floor_empty">（这一楼没有可显示的文字）</p>'}</div>
  ${book || sign ? `<div class="rs_floor_src">${book ? `<div>/ ${escapeHtml(book)} · 第 ${id} 楼</div>` : ''}${sign ? `<div class="rs_floor_sign">${escapeHtml(sign)}</div>` : ''}</div>` : ''}
</section>`;
}

const readerFontSize = () => Math.min(28, Math.max(13, parseInt(settings().readerFont) || DEFAULTS.readerFont));

function readerColors() {
    const s = settings();
    if (s.readerTheme === 'follow') return null;
    return { ...(READER_PRESETS[s.readerTheme] || READER_PRESETS.paper), ...(s.readerColors || {}) };
}

function applyReaderStyle() {
    const s = settings();
    const $b = $('#rs_panel .rs_reader_body');
    const colors = readerColors();
    $b.toggleClass('rs_rd_follow', !colors).toggleClass('rs_rd_indent', !!s.readerIndent);
    COLOR_KEYS.forEach(([k]) => $b[0].style.setProperty(`--rd-${k}`, colors ? colors[k] : ''));
    $b.css('font-size', readerFontSize() + 'px');
    $('#rs_panel .rs_rd_bar .rs_bar_title').text(String(s.readerBook || '').trim() || `共 ${ctx().chat.length} 楼`);
    syncReaderSetUI();
}

function toHex(css) {
    css = String(css);
    const m = css.match(/-?\d*\.?\d+/g);
    if (!m || m.length < 3) return '#888888';
    const scale = css.startsWith('color(') ? 255 : 1;
    return '#' + m.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(Number(x) * scale))).toString(16).padStart(2, '0')).join('');
}

function computedReaderColors() {
    const $b = $('#rs_panel .rs_reader_body');
    if (!$b.length) return null;
    const probe = name => {
        const el = document.createElement('span');
        el.style.color = `var(--rd-${name})`;
        $b[0].appendChild(el);
        const v = getComputedStyle(el).color;
        el.remove();
        return toHex(v);
    };
    const bg = getComputedStyle($('#rs_panel')[0]).backgroundColor;
    return { bg: toHex(bg), text: probe('text'), quote: probe('quote'), italic: probe('italic'), muted: probe('muted') };
}

function syncReaderSetUI() {
    const s = settings();
    const colors = readerColors() || computedReaderColors();
    $('#rs_panel .rs_rd_sw').each(function () { $(this).toggleClass('rs_on', this.dataset.p === s.readerTheme); });
    COLOR_KEYS.forEach(([k]) => $(`#rs_panel .rs_rd_color[data-k="${k}"]`).val(colors?.[k] || '#888888'));
    $('#rs_panel .rs_rd_fs').text(readerFontSize());
    $('#rs_panel .rs_rd_indent_cb').prop('checked', !!s.readerIndent);
    $('#rs_panel .rs_rd_time_cb').prop('checked', !!s.readerShowTime);
    $('#rs_panel .rs_rd_cb').each(function () { this.checked = !!s[this.dataset.k]; });
    $('#rs_panel .rs_rd_text').each(function () {
        if (document.activeElement !== this) this.value = s[this.dataset.k] ?? '';
    });
}

function setReaderOption(key, value) {
    settings()[key] = value;
    ctx().saveSettingsDebounced();
    applyReaderStyle();
}

function renderReader() {
    const chat = ctx().chat;
    let html = reader.from > 0 ? `<div class="rs_rd_more">加载更早的 ${Math.min(READER_CHUNK, reader.from)} 楼（前面还有 ${reader.from} 楼）</div>` : '';
    for (let id = reader.from; id < chat.length; id++) html += floorHtml(id);
    clearSel();
    $('#rs_panel .rs_reader_body').html(html).find('img.rs_floor_av').on('error', function () {
        $(this).next('.rs_floor_av_none').prop('hidden', false);
        $(this).remove();
    });
}

function openReader() {
    const chat = ctx().chat;
    reader.from = Math.max(0, chat.length - READER_CHUNK);
    reader.hits = [];
    reader.cur = -1;
    reader.undo = [];
    $('#rs_panel .rs_rd_ex').val(settings().findExclude);
    applyReaderStyle();
    if (boxOpenReaderFind()) readerSearch();
    renderReader();
    const body = $('#rs_panel .rs_reader_body')[0];
    body.scrollTop = body.scrollHeight;
}

function loadEarlier() {
    const body = $('#rs_panel .rs_reader_body')[0];
    const before = body.scrollHeight - body.scrollTop;
    reader.from = Math.max(0, reader.from - READER_CHUNK);
    renderReader();
    body.scrollTop = body.scrollHeight - before;
}

function scrollToFloor(id, hitIndex) {
    if (id < reader.from) {
        reader.from = Math.max(0, id - 3);
        renderReader();
    }
    const body = $('#rs_panel .rs_reader_body')[0];
    const target = hitIndex !== undefined
        ? body.querySelector(`.rs_rhit[data-h="${hitIndex}"]`)
        : body.querySelector(`.rs_floor[data-id="${id}"]`);
    if (!target) return;
    const top = target.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
    body.scrollTop = Math.max(0, top - (hitIndex !== undefined ? body.clientHeight / 3 : 8));
}

async function jumpToFloor() {
    const n = await askInput(`跳到第几楼？（0 到 ${ctx().chat.length - 1}）`, '');
    if (n === null || n === undefined || n === false || String(n).trim() === '') return;
    const id = parseInt(n);
    if (!Number.isInteger(id) || id < 0 || id >= ctx().chat.length) {
        toastr.warning('没有这一楼');
        return;
    }
    scrollToFloor(id);
}

const boxOpenReaderFind = () => $('#rs_panel .rs_rd_find').is(':visible');
const rdQuery = () => String($('#rs_panel .rs_rd_q').val() ?? '');

function readerSearch() {
    const q = rdQuery();
    reader.hits = [];
    reader.cur = -1;
    if (q) {
        ctx().chat.forEach((m, id) => {
            const raw = String(m.mes ?? '');
            const skip = excludedSpans(raw);
            const { shown } = readerDisplay(raw);
            let i = raw.indexOf(q);
            while (i >= 0) {
                const end = i + q.length;
                const visible = shown.subarray(i, end).every(x => x);
                if (visible && !skip.some(([a, b]) => i < b && end > a)) reader.hits.push({ id, a: i, b: end });
                i = raw.indexOf(q, end);
            }
        });
    }
    const floors = new Set(reader.hits.map(h => h.id)).size;
    $('#rs_panel .rs_rd_info').text(q ? `${reader.hits.length} 处${floors ? `，${floors} 楼` : ''}` : '');
}

function showHit(i) {
    reader.cur = i;
    const h = reader.hits[i];
    scrollToFloor(h.id, i);
    $('#rs_panel .rs_rhit_cur').removeClass('rs_rhit_cur');
    $(`#rs_panel .rs_rhit[data-h="${i}"]`).addClass('rs_rhit_cur');
}

function readerNext() {
    if (!reader.hits.length) {
        toastr.info('没有找到');
        return;
    }
    showHit((reader.cur + 1) % reader.hits.length);
}

function setFloorText(id, text) {
    const c = ctx();
    const m = c.chat[id];
    m.mes = text;
    if (Array.isArray(m.swipes) && m.swipes.length) m.swipes[m.swipe_id ?? 0] = text;
    c.updateMessageBlock(id, m);
}

async function readerReplace(all) {
    if (!reader.hits.length) {
        toastr.info('没有找到');
        return;
    }
    const rep = String($('#rs_panel .rs_rd_r').val() ?? '');
    const chat = ctx().chat;
    let targets;
    if (all) {
        const floors = new Set(reader.hits.map(h => h.id)).size;
        if (!(await askConfirm(`要在 ${floors} 楼里替换 ${reader.hits.length} 处吗？可以用「撤销替换」恢复`))) return;
        targets = reader.hits;
    } else {
        if (reader.cur < 0) {
            readerNext();
            return;
        }
        targets = [reader.hits[reader.cur]];
    }
    const byFloor = new Map();
    targets.forEach(h => byFloor.set(h.id, [...(byFloor.get(h.id) || []), h]));
    const batch = [];
    byFloor.forEach((hs, id) => {
        let text = String(chat[id].mes);
        batch.push({ id, old: text });
        hs.sort((x, y) => y.a - x.a).forEach(h => { text = text.slice(0, h.a) + rep + text.slice(h.b); });
        setFloorText(id, text);
    });
    reader.undo.push(batch);
    await ctx().saveChat();

    const last = targets[0];
    readerSearch();
    renderReader();
    if (all) {
        toastr.success(`已替换 ${targets.length} 处`);
    } else {
        const next = reader.hits.findIndex(h => h.id > last.id || (h.id === last.id && h.a >= last.a + rep.length));
        if (next >= 0) showHit(next);
        else scrollToFloor(last.id);
    }
}

async function readerUndo() {
    const batch = reader.undo.pop();
    if (!batch) {
        toastr.info('没有可以撤销的替换');
        return;
    }
    batch.forEach(({ id, old }) => setFloorText(id, old));
    await ctx().saveChat();
    readerSearch();
    renderReader();
    scrollToFloor(batch[0].id);
    toastr.success('已撤销上一次替换');
}

const DRAFT_DELAY = 600;
let draftTimer = 0;

function draftStoreKey() {
    const id = state.target?.key || state.target?.draftKey;
    return id ? `regenSplice:draft:${id}` : null;
}

function saveDraftNow() {
    clearTimeout(draftTimer);
    const k = draftStoreKey();
    if (!k || !bodyEl()) return;
    try {
        if (isDirty()) localStorage.setItem(k, JSON.stringify({ text: bodyEl().value, base: state.target.initial, time: Date.now() }));
        else localStorage.removeItem(k);
    } catch { }
}

function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraftNow, DRAFT_DELAY);
}

function clearDraft() {
    clearTimeout(draftTimer);
    const k = draftStoreKey();
    if (k) {
        try { localStorage.removeItem(k); } catch { }
    }
}

async function offerDraft() {
    const k = draftStoreKey();
    if (!k) return;
    let d = null;
    try { d = JSON.parse(localStorage.getItem(k) || 'null'); } catch { }
    if (!d || typeof d.text !== 'string' || d.text === state.target.initial) return;
    const note = d.base !== state.target.initial ? '（原文之后在别处改过）' : '';
    if (await askConfirm(`有一份 ${fmtTime(d.time)} 没保存的修改${note}，要恢复吗？`)) {
        setBody(d.text, 0);
        toastr.info('已恢复草稿，点保存才会生效');
    } else {
        clearDraft();
    }
}

function afterEdit() {
    renderBack();
    saveDraftSoon();
}

function setClicheSetting(key, value) {
    settings()[key] = value;
    ctx().saveSettingsDebounced();
    $('#rs_cliche_on, #rs_panel .rs_cliche_toggle').prop('checked', settings().clicheOn);
    $('#rs_cliche_whole, #rs_panel .rs_cliche_whole').prop('checked', settings().clicheWhole);
    $('#rs_cliche_words, #rs_panel .rs_cliche_input').not(document.activeElement).val(settings().clicheWords);
    if (state.target) {
        renderBack();
        renderRef();
    }
}

function jumpToNextCliche() {
    if (!settings().clicheOn) {
        setClicheSetting('clicheOn', true);
        return;
    }
    const ta = bodyEl();
    if (!ta) return;
    const hits = clicheRanges(ta.value);
    if (!hits.length) {
        toastr.info('正文里没有八股词了');
        return;
    }
    if (boxOpen('find')) toggleBox('find');
    selectHit(hits, nextIndex(hits));
}

function syncBackScroll() {
    const ta = bodyEl();
    const back = $('#rs_panel .rs_body_back')[0];
    if (ta && back) back.scrollTop = ta.scrollTop;
}

let backRaf = 0;
function scheduleBack() {
    cancelAnimationFrame(backRaf);
    backRaf = requestAnimationFrame(afterEdit);
}

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

let gripDrag = null;

const bodyEl = () => $('#rs_panel .rs_body_text')[0];
const snap = () => {
    const ta = bodyEl();
    return { v: ta.value, s: ta.selectionStart, e: ta.selectionEnd };
};
const isDirty = () => !!state.target && state.target.kind !== 'reader' && !!bodyEl() && bodyEl().value !== state.target.initial;

function ensureShell() {
    if ($('#rs_overlay').length) return;
    $('body').append(`
<div id="rs_overlay">
  <div id="rs_panel">
    <div class="rs_bar rs_top">
      <select class="rs_kind text_pole">
        <option value="msg">楼层</option>
        <option value="char">角色卡</option>
        <option value="persona">用户人设</option>
        <option value="world">世界书</option>
        <option value="reader">阅读</option>
      </select>
      <div class="rs_bar_title rs_title"></div>
      <div class="rs_ball_toggle" title="显示或隐藏悬浮球"><span>悬浮球</span><i></i></div>
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
      <div class="rs_bodyonly" title="只编辑正文 / 编辑全文"></div>
      <div class="rs_cliche" title="跳到下一个八股词"></div>
      <div class="rs_bar_spacer"></div>
      <div class="rs_icon rs_cliche_set fa-solid fa-list-ul" title="编辑八股词表"></div>
      <div class="rs_icon rs_find_btn fa-solid fa-magnifying-glass" title="查找替换"></div>
      <div class="rs_icon rs_lib_btn fa-solid fa-star" title="素材库"></div>
      <div class="rs_icon rs_undo fa-solid fa-rotate-left" title="撤销"></div>
      <div class="rs_icon rs_redo fa-solid fa-rotate-right" title="恢复"></div>
      <div class="rs_icon rs_ver_add fa-solid fa-bookmark" title="存为版本"></div>
      <div class="menu_button rs_save">保存</div>
    </div>
    <div class="rs_lib_box">
      <div class="rs_lib_head">
        <input type="text" class="rs_lib_q" placeholder="搜素材">
        <div class="menu_button rs_lib_add">收藏选中</div>
      </div>
      <div class="rs_lib_list"></div>
    </div>
    <div class="rs_find_box">
      <div class="rs_find_row">
        <input type="text" class="rs_find_q" placeholder="查找">
        <span class="rs_find_info"></span>
        <div class="menu_button rs_find_next">下一个</div>
      </div>
      <div class="rs_find_row">
        <input type="text" class="rs_find_r" placeholder="替换成（留空就是删除）">
        <div class="menu_button rs_find_one">替换</div>
        <div class="menu_button rs_find_all">全部</div>
      </div>
      <div class="rs_find_row">
        <input type="text" class="rs_find_ex" placeholder="跳过这些标签里的内容，比如 count think">
      </div>
    </div>
    <div class="rs_cliche_box">
      <div class="rs_cliche_opts">
        <label class="checkbox_label"><input type="checkbox" class="rs_cliche_toggle"> 标出八股词</label>
        <label class="checkbox_label"><input type="checkbox" class="rs_cliche_whole"> 整句标出</label>
      </div>
      <textarea class="rs_cliche_input" rows="4" spellcheck="false" placeholder="一行一个；中间隔字用 ……，比如 不是……而是&#10;想替换而不是删掉就写：极其 → 很"></textarea>
      <div class="menu_button rs_cliche_fix">一键处理全部八股</div>
    </div>
    <div class="rs_reader">
      <div class="rs_bar rs_rd_bar">
        <div class="rs_bar_title"></div>
        <div class="rs_icon rs_rd_set_btn fa-solid fa-sliders" title="排版和颜色"></div>
        <div class="rs_icon rs_rd_jump fa-solid fa-location-arrow" title="跳到第几楼"></div>
        <div class="rs_icon rs_rd_find_btn fa-solid fa-magnifying-glass" title="查找替换"></div>
      </div>
      <div class="rs_rd_set">
        <div class="rs_rd_row">
          <span class="rs_rd_label">配色</span>
          ${Object.entries(READER_PRESETS).map(([k, v]) => `<div class="rs_rd_sw" data-p="${k}" style="background:${v.bg};color:${v.quote}">${v.name}</div>`).join('')}
          <div class="rs_rd_sw rs_rd_sw_follow" data-p="follow">跟随</div>
        </div>
        <div class="rs_rd_row rs_rd_colors">
          ${COLOR_KEYS.map(([k, t]) => `<label class="rs_rd_color_item"><input type="color" class="rs_rd_color" data-k="${k}"><span>${t}</span></label>`).join('')}
        </div>
        <div class="rs_rd_row">
          <span class="rs_rd_label">字号</span>
          <div class="rs_icon rs_rd_fontbtn" data-d="-1">A-</div>
          <span class="rs_rd_fs"></span>
          <div class="rs_icon rs_rd_fontbtn" data-d="1">A+</div>
          <label class="checkbox_label"><input type="checkbox" class="rs_rd_indent_cb"> 段首缩进</label>
          <label class="checkbox_label"><input type="checkbox" class="rs_rd_time_cb"> 显示日期</label>
        </div>
        <div class="rs_rd_row">
          <label class="checkbox_label"><input type="checkbox" class="rs_rd_cb" data-k="readerMarkdown"> Markdown（**粗体** *斜体* ~~删除线~~）</label>
          <label class="checkbox_label"><input type="checkbox" class="rs_rd_cb" data-k="readerQuote"> 对话染色</label>
          <label class="checkbox_label"><input type="checkbox" class="rs_rd_cb" data-k="readerHideCode"> 隐藏代码块</label>
        </div>
        <div class="rs_find_row">
          <input type="text" class="rs_rd_text" data-k="readerBook" placeholder="书名">
          <input type="text" class="rs_rd_text" data-k="readerSign" placeholder="落款，显示在书名下面">
        </div>
        <div class="rs_find_row">
          <input type="text" class="rs_rd_text" data-k="readerBody" placeholder="只看这个标签里的正文，如 content">
          <input type="text" class="rs_rd_text" data-k="readerHide" placeholder="不显示的标签，如 think">
        </div>
      </div>
      <div class="rs_rd_find">
        <div class="rs_find_row">
          <input type="text" class="rs_rd_q" placeholder="在整个聊天里查找">
          <span class="rs_find_info rs_rd_info"></span>
          <div class="menu_button rs_rd_next">下一个</div>
        </div>
        <div class="rs_find_row">
          <input type="text" class="rs_rd_r" placeholder="替换成（留空就是删除）">
          <div class="menu_button rs_rd_one">替换</div>
          <div class="menu_button rs_rd_all">全部</div>
        </div>
        <div class="rs_find_row">
          <input type="text" class="rs_rd_ex" placeholder="跳过这些标签里的内容，比如 count think">
          <div class="menu_button rs_rd_undo">撤销替换</div>
        </div>
      </div>
      <div class="rs_reader_body"></div>
    </div>
    <div class="rs_body_wrap">
      <div class="rs_body_back" aria-hidden="true"></div>
      <textarea class="rs_body_text" spellcheck="false"></textarea>
    </div>
  </div>
</div>`);
    bodyEl().addEventListener('scroll', syncBackScroll, { passive: true });
    updateBallToggle();
    window.visualViewport?.addEventListener('resize', fitToViewport);
    window.visualViewport?.addEventListener('scroll', fitToViewport);
    fitToViewport();
}

const KEYBOARD_MIN = 120;
const KEYBOARD_REF_RATIO = 0.2;

function fitToViewport() {
    const ov = document.getElementById('rs_overlay');
    if (!ov) return;
    const vv = window.visualViewport;
    if (vv) {
        ov.style.top = vv.offsetTop + 'px';
        ov.style.height = vv.height + 'px';
        ov.classList.toggle('rs_kb', window.innerHeight - vv.height > KEYBOARD_MIN);
    }
    applySplitRatio();
}

function applySplitRatio() {
    if (gripDrag) return;
    const ratio = Math.min(0.8, Math.max(0.15, Number(settings().splitRatio) || DEFAULTS.splitRatio));
    const r = $('#rs_overlay').hasClass('rs_kb') ? Math.min(ratio, KEYBOARD_REF_RATIO) : ratio;
    $('#rs_panel .rs_ref_pane').css('height', Math.round($('#rs_panel').height() * r) + 'px');
}

function showTarget(t) {
    if (!t) return;
    ensureShell();
    clearSel();
    $('#rs_panel').toggleClass('rs_mode_reader', t.kind === 'reader');
    if (t.kind === 'reader') {
        state.target = t;
        $('#rs_panel .rs_kind').val('reader');
        $('#rs_panel .rs_title').text(t.subtitle);
        if (settings().lastKind !== 'reader') {
            settings().lastKind = 'reader';
            ctx().saveSettingsDebounced();
        }
        openReader();
        return;
    }
    Object.assign(state, { target: t, ref: t.ref, used: new Set(), caret: null, undo: [], redo: [], typing: false });

    $('#rs_panel .rs_title').html(t.subtitle || '');
    $('#rs_panel .rs_kind').val(t.kind);
    if (settings().lastKind !== t.kind) {
        settings().lastKind = t.kind;
        ctx().saveSettingsDebounced();
    }
    $('#rs_panel .rs_pickers').html(t.pickers).toggle(!!t.pickers);
    fillRefSelect(t.ref);
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
    renderBack();
    offerDraft();
}

async function switchTarget(loader) {
    if (isDirty()) {
        if (!(await askConfirm('正文改了还没保存，切换会丢掉改动，继续吗？'))) return false;
        clearDraft();
    }
    const t = await loader();
    if (!t) return false;
    showTarget(t);
    return true;
}

function fillRefSelect(idx) {
    let html = '';
    let group = null;
    state.target.refs.forEach((r, i) => {
        if ((r.group || null) !== group) {
            if (group) html += '</optgroup>';
            group = r.group || null;
            if (group) html += `<optgroup label="${escapeHtml(group)}">`;
        }
        html += `<option value="${i}">${escapeHtml(r.label)}</option>`;
    });
    if (group) html += '</optgroup>';
    $('#rs_panel .rs_ref').html(html).val(String(idx));
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
    fillRefSelect(idx);
    updateRefButtons();
    renderRef();
    renderBack();
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
    afterEdit();
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
    const bodySet = state.diff ? sentenceSet(bodyEl().value) : null;
    const html = String(refText).split('\n').map((line, li) => {
        if (!line.trim()) return '';
        const spans = splitSentences(line).map((s, si) => {
            const k = `${state.ref}-${li}-${si}`;
            const cls = state.used.has(k) ? 'rs_used' : (bodySet && s.trim() && !bodySet.has(s.trim()) ? 'rs_gone' : '');
            const inner = clicheActive() ? markCliche(s).html : escapeHtml(s);
            return `<span class="rs_s ${cls}" data-k="${k}" data-g="${li}" data-i="${si}">${inner}</span>`;
        }).join('');
        return `<p>${spans}</p>`;
    }).join('');
    sel = null;
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
    try { ta.setSelectionRange(sn.s, sn.e); } catch { }
    state.last = snap();
    if (state.diff) renderRef();
    afterEdit();
}

function updateUndoButtons() {
    $('#rs_panel .rs_undo').toggleClass('rs_off', !state.undo.length);
    $('#rs_panel .rs_redo').toggleClass('rs_off', !state.redo.length);
}

function insertSentence(text) {
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
    try { ta.setSelectionRange(pos, pos); } catch { }
    state.last = { v: ta.value, s: pos, e: pos };
    renderRef();
    updateUndoButtons();
    afterEdit();

    const wrap = ta.parentElement;
    wrap.classList.remove('rs_flash');
    void wrap.offsetWidth;
    wrap.classList.add('rs_flash');
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
    scheduleBack();
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
    if ($('#rs_overlay').hasClass('rs_kb')) return;
    settings().splitRatio = $('#rs_panel .rs_ref_pane').height() / $('#rs_panel').height();
    ctx().saveSettingsDebounced();
}

async function closePanel(force = false, keepDraft = false) {
    if (!force && isDirty() && !(await askConfirm('正文改了还没保存，确定关闭吗？'))) return;
    if (keepDraft) saveDraftNow();
    else clearDraft();
    clearTimeout(state.typingTimer);
    clearTimeout(state.diffTimer);
    state.target = null;
    window.visualViewport?.removeEventListener('resize', fitToViewport);
    window.visualViewport?.removeEventListener('scroll', fitToViewport);
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
    clearDraft();
    if (t.closeAfterSave) {
        closePanel(true);
        return;
    }
    t.initial = text;
    reloadCurrent();
}

async function reloadCurrent() {
    const t = state.target;
    if (t.kind === 'char') showTarget(await charTarget(t.field));
    else if (t.kind === 'persona') showTarget(await personaTarget());
    else if (t.kind === 'world') showTarget(await worldTarget(t.book, $('#rs_panel .rs_pick[data-pick="entry"]').val()));
}

function openPanel(id) {
    showTarget(msgTarget(id));
}

const LOADERS = {
    msg: async () => {
        const id = lastAiIndex();
        if (id < 0) {
            toastr.warning('当前聊天里还没有 AI 回复');
            return null;
        }
        return msgTarget(id);
    },
    char: () => charTarget(),
    persona: () => personaTarget(),
    world: () => worldTarget(),
    reader: async () => {
        if (!ctx().chat.length) {
            toastr.warning('当前聊天还没有消息');
            return null;
        }
        return { kind: 'reader', subtitle: '整个聊天', initial: '' };
    },
};

async function openFromBall() {
    if ($('#rs_overlay').length) return;
    const first = settings().lastKind in LOADERS ? settings().lastKind : 'msg';
    const order = [first, ...Object.keys(LOADERS).filter(k => k !== first)];
    for (const k of order) {
        const t = await LOADERS[k]();
        if (t) {
            showTarget(t);
            return;
        }
    }
}

function bindPanelEvents() {
    $(document)
        .on('click', '#rs_wand_open', () => {
            $('#extensionsMenu').hide();
            openFromBall();
        })
        .on('click', '#rs_panel .rs_ball_toggle', () => setBallVisible(!settings().ball))
        .on('click', '#chat .mes_text', onMessageClick)
        .on('pointerdown', '.rs_inline_btn', e => e.preventDefault())
        .on('click', '.rs_inline_btn', function (e) {
            e.stopPropagation();
            if (!tap) return;
            const act = this.dataset.act;
            if (act === 'ok') confirmInlineEdit();
            else if (act === 'cancel') endInlineEdit(true);
            else if (act === 'undo') inlineUndo();
            else if (act === 'redo') inlineRedo();
            else if (act === 'all') {
                tap.ta.focus();
                tap.ta.setSelectionRange(0, tap.ta.value.length);
            }
            else if (act === 'copy') {
                const ta = tap.ta;
                copyText(ta.selectionEnd > ta.selectionStart ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value);
            }
        })
        .on('input', '.rs_inline_ta', () => {
            if (!tap) return;
            fitInline();
            clearTimeout(tap.timer);
            tap.timer = setTimeout(inlineSnap, INLINE_UNDO_PAUSE);
            updateInlineButtons();
        })
        .on('keydown', '.rs_inline_ta', e => {
            if (e.key === 'Escape') endInlineEdit(true);
        })
        .on('click', '#chat .rs_vchip_arrow', function (e) {
            e.stopPropagation();
            closeVersionMenu();
            const id = Number($(this).closest('.rs_vchip').attr('data-id'));
            const m = ctx().chat[id];
            switchVersion(id, (Number.isInteger(m.swipe_id) ? m.swipe_id : 0) + Number(this.dataset.d));
        })
        .on('click', '#chat .rs_vchip_num', function (e) {
            e.stopPropagation();
            const id = Number($(this).closest('.rs_vchip').attr('data-id'));
            if ($('#rs_vmenu').attr('data-id') === String(id)) closeVersionMenu();
            else openVersionMenu(id, this);
        })
        .on('click', '#rs_vmenu .rs_vmenu_item', function () {
            if (this.dataset.file) {
                openBranch(this.dataset.file);
                return;
            }
            if (this.dataset.i === undefined) {
                closeVersionMenu();
                return;
            }
            const id = Number($('#rs_vmenu').attr('data-id'));
            closeVersionMenu();
            switchVersion(id, Number(this.dataset.i));
        })
        .on('click', '#chat .rs_bchip', function (e) {
            e.stopPropagation();
            const id = Number(this.getAttribute('data-id'));
            if ($('#rs_vmenu').attr('data-branch') === String(id)) closeVersionMenu();
            else openBranchMenu(id, this);
        })
        .on('pointerdown', e => {
            if ($('#rs_vmenu').length && !$(e.target).closest('#rs_vmenu, .rs_vchip, .rs_bchip').length) closeVersionMenu();
        })
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
            renderBack();
            $('#rs_panel .rs_ref_pane').scrollTop(0);
        })
        .on('change', '#rs_panel .rs_pick', async function () {
            const pick = $(this).data('pick');
            const val = $(this).val();
            const prev = $(this).find('option[selected]').val();
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
            renderBack();
        })
        .on('click', '#rs_panel .rs_s', function (e) {
            e.stopPropagation();
            onSentenceTap(this);
        })
        .on('click', '#rs_panel .rs_tb_btn', function (e) {
            e.stopPropagation();
            onToolbarAct(this.dataset.act);
        })
        .on('click', '#rs_panel .rs_ref_pane, #rs_panel .rs_reader_body', clearSel)
        .on('focus', '#rs_panel .rs_body_text', function () { this.parentElement.classList.add('rs_focus'); })
        .on('blur', '#rs_panel .rs_body_text', function () {
            this.parentElement.classList.remove('rs_focus');
            renderBack();
        })
        .on('click', '#rs_panel .rs_lib_btn', () => toggleBox('lib'))
        .on('click', '#rs_panel .rs_rd_set_btn', function () {
            const $set = $('#rs_panel .rs_rd_set').toggle();
            $('#rs_panel .rs_rd_find').hide();
            $('#rs_panel .rs_rd_find_btn').removeClass('rs_on');
            $(this).toggleClass('rs_on', $set.is(':visible'));
            syncReaderSetUI();
        })
        .on('click', '#rs_panel .rs_rd_sw', function () {
            settings().readerColors = null;
            setReaderOption('readerTheme', this.dataset.p);
        })
        .on('input', '#rs_panel .rs_rd_color', function () {
            const s = settings();
            if (s.readerTheme === 'follow') {
                s.readerColors = computedReaderColors();
                s.readerTheme = 'paper';
            }
            s.readerColors = { ...(s.readerColors || {}), [this.dataset.k]: this.value };
            setReaderOption('readerColors', s.readerColors);
        })
        .on('click', '#rs_panel .rs_rd_fontbtn', function () {
            setReaderOption('readerFont', readerFontSize() + Number(this.dataset.d));
        })
        .on('change', '#rs_panel .rs_rd_indent_cb', function () { setReaderOption('readerIndent', this.checked); })
        .on('change', '#rs_panel .rs_rd_time_cb', function () {
            setReaderOption('readerShowTime', this.checked);
            renderReader();
        })
        .on('change', '#rs_panel .rs_rd_cb', function () {
            setReaderOption(this.dataset.k, this.checked);
            if (boxOpenReaderFind()) readerSearch();
            renderReader();
        })
        .on('input', '#rs_panel .rs_rd_text', function () {
            setReaderOption(this.dataset.k, this.value);
            if (boxOpenReaderFind()) readerSearch();
            renderReader();
        })
        .on('click', '#rs_panel .rs_rd_jump', jumpToFloor)
        .on('click', '#rs_panel .rs_rd_more', e => {
            e.stopPropagation();
            loadEarlier();
        })
        .on('click', '#rs_panel .rs_rd_find_btn', function () {
            $('#rs_panel .rs_rd_set').hide();
            $('#rs_panel .rs_rd_set_btn').removeClass('rs_on');
            const $f = $('#rs_panel .rs_rd_find').toggle();
            $(this).toggleClass('rs_on', $f.is(':visible'));
            if ($f.is(':visible')) $('#rs_panel .rs_rd_q').trigger('focus');
            readerSearch();
            renderReader();
        })
        .on('input', '#rs_panel .rs_rd_q', () => {
            readerSearch();
            renderReader();
        })
        .on('input', '#rs_panel .rs_rd_ex', function () {
            settings().findExclude = this.value;
            ctx().saveSettingsDebounced();
            readerSearch();
            renderReader();
        })
        .on('keydown', '#rs_panel .rs_rd_q', e => { if (e.key === 'Enter') readerNext(); })
        .on('click', '#rs_panel .rs_rd_next', readerNext)
        .on('click', '#rs_panel .rs_rd_one', () => readerReplace(false))
        .on('click', '#rs_panel .rs_rd_all', () => readerReplace(true))
        .on('click', '#rs_panel .rs_rd_undo', readerUndo)
        .on('click', '#rs_panel .rs_lib_add', collectSelection)
        .on('input', '#rs_panel .rs_lib_q', renderLib)
        .on('click', '#rs_panel .rs_lib_main', function () { useLibItem($(this).closest('.rs_lib_item').data('id')); })
        .on('click', '#rs_panel .rs_lib_del', function () { deleteLibItem($(this).closest('.rs_lib_item').data('id')); })
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
        .on('change', '#rs_panel .rs_kind', async function () {
            const prev = state.target?.kind;
            const ok = await switchTarget(LOADERS[this.value]);
            if (!ok && prev) $(this).val(prev);
        })
        .on('click', '#rs_panel .rs_cliche', jumpToNextCliche)
        .on('click', '#rs_panel .rs_cliche_set', () => {
            const $box = $('#rs_panel .rs_cliche_box');
            $box.find('.rs_cliche_toggle').prop('checked', settings().clicheOn);
            $box.find('.rs_cliche_whole').prop('checked', settings().clicheWhole);
            $box.find('.rs_cliche_input').val(settings().clicheWords);
            toggleBox('cliche');
        })
        .on('click', '#rs_panel .rs_cliche_fix', fixAllCliche)
        .on('click', '#rs_panel .rs_bodyonly', () => {
            if (isDirty()) {
                toastr.info('先写回或撤回修改，再切换');
                return;
            }
            settings().editBodyOnly = !settings().editBodyOnly;
            ctx().saveSettingsDebounced();
            showTarget(msgTarget(state.target.id));
        })
        .on('click', '#rs_panel .rs_find_btn', () => {
            $('#rs_panel .rs_find_ex').val(settings().findExclude);
            toggleBox('find');
        })
        .on('input', '#rs_panel .rs_find_ex', function () {
            settings().findExclude = this.value;
            ctx().saveSettingsDebounced();
            renderBack();
        })
        .on('input', '#rs_panel .rs_find_q', renderBack)
        .on('keydown', '#rs_panel .rs_find_q', e => { if (e.key === 'Enter') findNext(); })
        .on('click', '#rs_panel .rs_find_next', findNext)
        .on('click', '#rs_panel .rs_find_one', replaceOne)
        .on('click', '#rs_panel .rs_find_all', replaceAll)
        .on('change', '#rs_panel .rs_cliche_toggle', function () { setClicheSetting('clicheOn', this.checked); })
        .on('change', '#rs_panel .rs_cliche_whole', function () { setClicheSetting('clicheWhole', this.checked); })
        .on('input', '#rs_panel .rs_cliche_input', function () { setClicheSetting('clicheWords', this.value); });

    document.addEventListener('selectionchange', () => {
        const ta = document.querySelector('#rs_panel .rs_body_text');
        if (ta && document.activeElement === ta) state.caret = { s: ta.selectionStart, e: ta.selectionEnd };
    });
}

const DRAG_THRESHOLD = 6;

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
    updateBallToggle();
    const s = settings();
    if (!s.ball) return;

    const $b = $('<div id="rs_ball" title="打开编辑面板"></div>').appendTo('body');
    $b.css({ width: s.ballSize + 'px', height: s.ballSize + 'px', fontSize: Math.round(s.ballSize * 0.4) + 'px' });
    if (s.ballImage && s.ballShape !== 'original') {
        $b.addClass('rs_ball_img').css('background-image', `url("${String(s.ballImage).replace(/"/g, '%22')}")`);
    } else if (s.ballImage) {
        $b.addClass('rs_ball_raw').css({ width: 'auto', height: 'auto' });
        $('<img>', { src: s.ballImage, draggable: false, alt: '' })
            .css({ maxWidth: s.ballSize + 'px', maxHeight: s.ballSize + 'px' })
            .on('load', () => placeBall($b[0].offsetLeft, $b[0].offsetTop))
            .appendTo($b);
    } else {
        $b.addClass('fa-solid fa-pen-nib');
    }

    const pos = s.ballPos || { x: window.innerWidth - s.ballSize - 12, y: window.innerHeight * 0.6 };
    placeBall(pos.x, pos.y);

    const el = $b[0];
    let drag = null;

    el.addEventListener('pointerdown', e => {
        drag = { sx: e.clientX, sy: e.clientY, l: el.offsetLeft, t: el.offsetTop, moved: false, long: false };
        drag.timer = setTimeout(() => {
            if (!drag || drag.moved) return;
            drag.long = true;
            setBallVisible(false);
            toastr.info('悬浮球已隐藏。从魔棒菜单打开插件，在顶部可以重新打开');
        }, BALL_LONG_PRESS);
        el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            drag.moved = true;
            clearTimeout(drag.timer);
        }
        if (drag.moved) placeBall(drag.l + dx, drag.t + dy);
    });

    el.addEventListener('pointerup', () => {
        if (!drag) return;
        clearTimeout(drag.timer);
        const { moved, long } = drag;
        drag = null;
        if (long) return;
        if (moved) {
            settings().ballPos = { x: el.offsetLeft, y: el.offsetTop };
            ctx().saveSettingsDebounced();
            return;
        }
        openFromBall();
    });

    el.addEventListener('pointercancel', () => {
        clearTimeout(drag?.timer);
        drag = null;
    });
    el.addEventListener('contextmenu', e => e.preventDefault());
}

const BALL_LONG_PRESS = 700;

function setBallVisible(on) {
    settings().ball = on;
    ctx().saveSettingsDebounced();
    $('#rs_ball_on').prop('checked', on);
    renderBall();
}

function guardSelection() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const mes = settings().selectGuard && sel.rangeCount && !sel.isCollapsed ? el?.closest?.('#chat .mes') : null;
    const cur = chat.querySelector('.mes.rs_sel_mes');
    if (mes === cur) return;
    cur?.classList.remove('rs_sel_mes');
    mes?.classList.add('rs_sel_mes');
    chat.classList.toggle('rs_selecting', !!mes);
}

function addWandMenu() {
    const $menu = $('#extensionsMenu');
    if (!$menu.length || $('#rs_wand_open').length) return;
    $menu.append(`
<div id="rs_wand_open" class="list-group-item flex-container flexGap5 interactable" tabindex="0">
  <div class="fa-solid fa-pen-nib extensionsMenuExtensionButton"></div>
  <span>重生成拼接</span>
</div>`);
}

function updateBallToggle() {
    const on = !!settings().ball;
    $('#rs_panel .rs_ball_toggle').toggleClass('rs_on', on)
        .find('i').attr('class', `fa-solid ${on ? 'fa-toggle-on' : 'fa-toggle-off'}`);
}

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
      <label class="checkbox_label"><input type="checkbox" id="rs_tap_on"> 双击聊天里的句子直接编辑</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_selguard_on"> 聊天里选字只选在同一楼（防止乱跳、选太多）</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_vchip_on"> 有多个版本的楼层显示版本切换</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_bchip_on"> 有分支的楼层显示分支切换</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_cliche_on"> 楼层编辑时标出八股词</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_cliche_whole"> 八股词整句标出</label>
      <label>八股词表（一行一个；中间隔字用 ……，比如 不是……而是；用 /.../ 包起来是正则）
        <textarea id="rs_cliche_words" class="text_pole" rows="6"></textarea>
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
    $('#rs_vchip_on').prop('checked', s.versionChip).on('change', function () {
        settings().versionChip = this.checked;
        ctx().saveSettingsDebounced();
        updateAllVersionChips();
    });
    $('#rs_selguard_on').prop('checked', s.selectGuard).on('change', function () {
        settings().selectGuard = this.checked;
        ctx().saveSettingsDebounced();
        guardSelection();
    });
    $('#rs_tap_on').prop('checked', s.tapEdit).on('change', function () {
        settings().tapEdit = this.checked;
        ctx().saveSettingsDebounced();
        endInlineEdit(true);
    });
    $('#rs_bchip_on').prop('checked', s.branchChip).on('change', function () {
        settings().branchChip = this.checked;
        ctx().saveSettingsDebounced();
        refreshBranches();
    });
    $('#rs_cliche_on').prop('checked', s.clicheOn).on('change', function () { setClicheSetting('clicheOn', this.checked); });
    $('#rs_cliche_whole').prop('checked', s.clicheWhole).on('change', function () { setClicheSetting('clicheWhole', this.checked); });
    $('#rs_cliche_words').val(s.clicheWords).on('input', function () { setClicheSetting('clicheWords', this.value); });
    $('#rs_snap_keep').val(s.snapKeep).on('input', function () {
        settings().snapKeep = Math.max(2, parseInt(this.value) || DEFAULTS.snapKeep);
        ctx().saveSettingsDebounced();
    });
}

jQuery(() => {
    const c = ctx();
    const ev = c.eventTypes || c.event_types;

    renderSettings();
    injectButtons();
    bindPanelEvents();
    renderBall();
    document.addEventListener('selectionchange', guardSelection);
    window.visualViewport?.addEventListener('resize', () => { if (tap) keepInView(); });
    addWandMenu();
    setTimeout(addWandMenu, 1500);
    window.addEventListener('resize', () => {
        const el = document.getElementById('rs_ball');
        if (el) placeBall(el.offsetLeft, el.offsetTop);
    });

    c.eventSource.on(ev.GENERATION_STARTED, onGenStarted);
    c.eventSource.on(ev.CHARACTER_MESSAGE_RENDERED, onCharRendered);
    [ev.CHARACTER_MESSAGE_RENDERED, ev.USER_MESSAGE_RENDERED, ev.MESSAGE_SWIPED, ev.MESSAGE_UPDATED, ev.MESSAGE_EDITED]
        .filter(Boolean)
        .forEach(e => c.eventSource.on(e, id => setTimeout(() => updateChipsById(id), 0)));
    [ev.MESSAGE_DELETED, ev.MORE_MESSAGES_LOADED, ev.CHAT_CHANGED]
        .filter(Boolean)
        .forEach(e => c.eventSource.on(e, () => setTimeout(updateAllVersionChips, 0)));
    if (ev.CHAT_CHANGED) {
        c.eventSource.on(ev.CHAT_CHANGED, () => {
            branchInfo = null;
            setTimeout(refreshBranches, 1500);
        });
    }
    updateAllVersionChips();
    refreshBranches();
    c.eventSource.on(ev.GENERATION_ENDED, onGenEnded);
    c.eventSource.on(ev.GENERATION_STOPPED, onGenEnded);
    c.eventSource.on(ev.CHAT_CHANGED, () => {
        if (state.target?.kind === 'reader') openReader();
        pending = null;
        injectButtons();
        if (state.target?.kind === 'msg') {
            closePanel(true, true);
            toastr.info('切换了聊天，楼层编辑面板已关闭');
        }
    });
});
