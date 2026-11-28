
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
    panelWidth: 720,
    panelHeight: 94,
    editFont: 15,
    accent: '',
    panelBg: '',
    panelText: '',
    dim: 45,
    pzRatio: 0.45,
    pzSchemes: {},
    pzRadio: {},
    snapKeep: 30,
    lastKind: 'msg',
    findExclude: '',
    readerBody: 'content',
    libMax: 500,
    clicheOn: true,
    versionChip: true,
    tapEdit: true,
    selectGuard: true,
    editBodyOnly: true,
    branchChip: true,
    jumpBar: true,
    holdScroll: true,
    clicheWhole: true,
    pzDividers: '',
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

const BTN_HTML = '<div title="版本拼接" class="mes_button regen_splice_btn fa-solid fa-scissors"></div><div title="收藏这一楼" class="mes_button rs_fav_btn fa-regular fa-star"></div>';
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
    const add = el => {
        $(el).find('.regen_splice_btn, .rs_fav_btn').remove();
        $(el).prepend(BTN_HTML);
    };
    $('#message_template .mes_buttons .extraMesButtons').each(function () {
        if (!$(this).find('.rs_fav_btn').length) add(this);
    });
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.rs_fav_btn').length) add(this);
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
        return await new Promise(res => {
            const tx = d.transaction('snaps', 'readwrite');
            tx.objectStore('snaps').put(value, key);
            tx.oncomplete = () => res(true);
            tx.onerror = () => res(false);
            tx.onabort = () => res(false);
        });
    } catch (e) {
        console.warn('[重生成拼接] 存储失败', e);
        return false;
    }
}

const unHtml = h => $('<div>').html(String(h ?? '')).text();
const BIN_KEY = 'bin';
const BIN_DAYS = 30;
const BIN_MAX = 300;
const BIN_PREVIEW = 60;
const BIN_TYPES = { fav: '收藏', card: '角色卡', persona: '用户人设', chat: '聊天文件', book: '世界书', pz: '预设条目', wi: '世界书条目', rx: '正则', swipe: '楼层版本', ver: '★版本', snap: '存档' };

async function binAll() {
    const cut = Date.now() - BIN_DAYS * 864e5;
    return ((await idbGet(BIN_KEY)) || []).filter(x => x.time >= cut);
}

async function binAdd(items) {
    const list = (Array.isArray(items) ? items : [items]).map(x => ({ id: pzUid(), time: Date.now(), ...x }));
    if (!list.length) return true;
    if (!(await idbPut(BIN_KEY, [...list, ...(await binAll())].slice(0, BIN_MAX)))) return false;
    const have = new Set((await binAll()).map(x => x.id));
    return list.every(x => have.has(x.id));
}

async function binDrop(ids) {
    const set = new Set(ids);
    await idbPut(BIN_KEY, (await binAll()).filter(x => !set.has(x.id)));
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
    const snaps = await getSnaps(key);
    for (let i = snaps.length - 1; i >= 0; i--) {
        const sn = snaps[i];
        if (sn.text !== initial) refs.push({ label: `存档 ${fmtTime(sn.time)}`, text: sn.text, snapIdx: i, time: sn.time });
    }
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
            ...versions.map((t, i) => ({ label: `版本 ${i + 1}${i === cur ? '（当前）' : ''}`, text: splitBody(t).body, group: '这一楼的版本', swipe: i === cur || versions.length < 2 ? undefined : i })),
            ...floors,
        ],
        ref,
        initial: lf(parts.body),
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
    favMarksSoon();
}

function updateChipsById(id) {
    const el = Number.isInteger(Number(id)) ? mesEl(Number(id)) : null;
    if (el) updateChipsOf(el);
    else updateAllVersionChips();
    favMarksSoon();
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

async function apiPost(url, body) {
    try {
        return await fetch(url, { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify(body) });
    } catch (e) {
        console.error('[重生成拼接] 请求失败', url, e);
        return null;
    }
}

async function postJson(url, body) {
    const res = await apiPost(url, body);
    if (!res?.ok) throw new Error(`${url} ${res?.status}`);
    return res.json();
}

async function formPost(url, form) {
    const headers = { ...ctx().getRequestHeaders() };
    delete headers['Content-Type'];
    try {
        return await fetch(url, { method: 'POST', headers, body: form, cache: 'no-cache' });
    } catch (e) {
        console.error('[重生成拼接] 上传失败', url, e);
        return null;
    }
}

function flip(set, k) {
    if (set.has(k)) set.delete(k);
    else set.add(k);
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

const TAP_SKIP = 'a, button, input, textarea, select, summary, img, video, audio, iframe, label, .rs_vchip, .rs_bchip, .mes_buttons, .mes_edit_buttons, .swipe_left, .swipe_right';
let tap = null;

function textPosAt(x, y) {
    if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    const r = document.caretRangeFromPoint?.(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
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

const FLAT_BLOCK = /^(P|DIV|LI|BLOCKQUOTE|H[1-6]|PRE|TR|UL|OL|SECTION|DETAILS|SUMMARY)$/;

function flatText(root) {
    const parts = [];
    let text = '';
    const walk = n => {
        if (n.nodeType === Node.TEXT_NODE) {
            parts.push({ node: n, at: text.length });
            text += n.data;
            return;
        }
        if (n.nodeName === 'BR') {
            text += '\n';
            return;
        }
        const block = n !== root && n.nodeType === Node.ELEMENT_NODE && FLAT_BLOCK.test(n.nodeName);
        if (block) text += '\n';
        n.childNodes.forEach(walk);
        if (block) text += '\n';
    };
    walk(root);
    return { text, parts };
}

function flatPos(parts, off, end) {
    let hit = parts[0];
    for (const p of parts) {
        if (end ? p.at < off : p.at <= off) hit = p;
        else break;
    }
    return hit && { node: hit.node, offset: Math.max(0, Math.min(off - hit.at, hit.node.length)) };
}

const NEAR_TEXT_PX = 40;

function nearestText(textEl, x, y) {
    const w = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let best = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.data.trim()) continue;
        r.selectNodeContents(n);
        for (const b of r.getClientRects()) {
            const dx = Math.max(b.left - x, 0, x - b.right);
            const dy = Math.max(b.top - y, 0, y - b.bottom);
            const d = Math.hypot(dx, dy);
            if (!best || d < best.d) best = { d, node: n, offset: x < b.left || y < b.top ? 0 : n.length };
        }
    }
    return best && best.d <= NEAR_TEXT_PX ? best : null;
}

function paragraphAtTap(e, textEl) {
    let pos = textPosAt(e.clientX, e.clientY);
    if (!pos || pos.node.nodeType !== Node.TEXT_NODE || !textEl.contains(pos.node) || !pos.node.data.trim()) pos = nearestText(textEl, e.clientX, e.clientY);
    if (!pos) return null;
    const { text, parts } = flatText(textEl);
    const part = parts.find(p => p.node === pos.node);
    if (!part) return null;
    const at = part.at + pos.offset;
    let a = text.lastIndexOf('\n', at - 1) + 1;
    let b = text.indexOf('\n', at);
    if (b < 0) b = text.length;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a >= b) return null;
    const s0 = flatPos(parts, a, false);
    const s1 = flatPos(parts, b, true);
    if (!s0 || !s1) return null;
    const range = document.createRange();
    range.setStart(s0.node, s0.offset);
    range.setEnd(s1.node, s1.offset);
    const sentence = text.slice(a, b);
    const before = document.createRange();
    before.setStart(textEl, 0);
    before.setEnd(s0.node, s0.offset);
    return { sentence, nth: countOf(before.toString(), range.toString()), range };
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

const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_DIST = 30;
const TAP_HOLD_MS = 500;
const TAP_MOVE_PX = 10;
let lastTap = null;
let tapDown = null;

function onMessageDown(e) {
    tapDown = e.isPrimary === false ? null : { t: Date.now(), x: e.clientX, y: e.clientY, el: e.currentTarget };
}

function onMessageUp(e) {
    const d = tapDown;
    tapDown = null;
    if (!settings().tapEdit) return;
    if (!d || d.el !== e.currentTarget || Date.now() - d.t > TAP_HOLD_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_MOVE_PX) {
        lastTap = null;
        return;
    }
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
    if (textEl.querySelector('textarea:not(.rs_inline_ta)')) return toastr.info('这楼正在用酒馆的编辑框，先关掉它');
    if (tap) {
        if (tap.ta.value !== tap.original) {
            toastr.info('上一个编辑框改过还没确认，先确认或取消');
            tap.box?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }
        endInlineEdit(true);
    }
    const mes = textEl.closest('.mes');
    const id = Number(mes?.getAttribute('mesid'));
    const m = ctx().chat[id];
    if (!Number.isInteger(id) || !m) return;
    const hit = paragraphAtTap(e, textEl);
    if (!hit) return toastr.info('没点到文字，双击段落里的字试试');
    const span = hit.range && locateInRaw(m.mes, hit.sentence, hit.nth);
    if (!span) {
        toastr.info('这段被正则改过显示，对不上原文，请用整楼编辑');
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
    const res = await apiPost('/api/characters/merge-attributes', body);
    if (!res?.ok) toastr.error('保存角色卡失败');
    return !!res?.ok;
}
const lf = v => String(v ?? '').replace(/\r\n?/g, '\n');

async function savedTarget(key, initial, rest) {
    return { refs: await buildRefs(key, initial), key, ref: 0, initial, saveLabel: '保存', closeAfterSave: false, ...rest };
}

function nameLabels(list, curMark) {
    const count = new Map();
    list.forEach(x => count.set(x.name, (count.get(x.name) || 0) + 1));
    return new Map(list.map(x => {
        const dup = count.get(x.name) > 1 ? `（${String(x.id).replace(/^c:/, '').replace(/\.[^.]+$/, '')}）` : '';
        return [x.id, x.name + dup + (x.id === curMark ? ' · 当前' : '')];
    }));
}

function nameOpts(list, cur, curMark) {
    const labels = nameLabels(list, curMark);
    return list.map(x => `<option value="${escapeHtml(x.id)}" ${x.id === cur ? 'selected' : ''}>${escapeHtml(labels.get(x.id))}</option>`).join('');
}

const charList = () => (ctx().characters || []).filter(c => c?.avatar).map(c => ({ id: c.avatar, name: String(c.name ?? c.avatar) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

async function fullChar(ch) {
    if (!ch?.shallow) return ch;
    const c = ctx();
    const chid = c.characters.indexOf(ch);
    try {
        if (typeof c.unshallowCharacter === 'function') await c.unshallowCharacter(chid);
        else {
            const res = await apiPost('/api/characters/get', { avatar_url: ch.avatar });
            if (res?.ok) {
                Object.assign(ch, await res.json());
                delete ch.shallow;
            }
        }
    } catch (e) {
        console.warn('[重生成拼接] 读取角色失败', e);
    }
    const now = c.characters[chid] || ch;
    if (now.shallow) toastr.warning('没读到这个角色的完整内容');
    return now;
}

async function charTarget(field = 'description', avatar = null) {
    const cur = currentChar();
    const ch = await fullChar((avatar && ctx().characters.find(c => c.avatar === avatar)) || cur || ctx().characters.find(c => c?.avatar));
    if (!ch) {
        toastr.warning('还没有角色卡');
        return null;
    }
    const isCur = ch === cur;
    const alts = Array.isArray(ch.data?.alternate_greetings) ? ch.data.alternate_greetings : [];
    const altMatch = String(field).match(/^alt:(\d+|new)$/);
    const altIndex = altMatch ? (altMatch[1] === 'new' ? alts.length : Number(altMatch[1])) : -1;
    const isAlt = altIndex >= 0 && altIndex <= alts.length;
    const def = isAlt ? null : CHAR_FIELDS.find(f => f[0] === field) || CHAR_FIELDS[0];
    if (!isAlt) field = def[0];
    else field = altIndex === alts.length ? 'alt:new' : `alt:${altIndex}`;

    const initial = lf(isAlt ? alts[altIndex] : (def[3] ? ch.data?.[def[0]] : ch[def[0]] ?? ch.data?.[def[0]]));
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
        avatar: ch.avatar,
        subtitle: escapeHtml(ch.name),
        pickers: `<span class="rs_icon rs_shelf_open fa-solid fa-table-cells-large" data-kind="char" title="角色书架"></span><select class="rs_pick text_pole" data-pick="charwho">${nameOpts(charList(), ch.avatar, cur?.avatar)}</select>
<select class="rs_pick text_pole" data-pick="char">${opts}</select>`,
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
            if (selector && isCur) $(selector).val(text);
            await addSnaps(key, initial, text);
            toastr.success('角色卡已保存');
            return true;
        },
    });
}

async function personaInfo() {
    const pu = ctx().powerUserSettings || {};
    let cur = null;
    try { cur = (await import('/script.js')).user_avatar || null; } catch { }
    const list = Object.entries(pu.personas || {}).map(([id, name]) => ({ id, name: String(name ?? id) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return { pu, cur, list };
}

async function personaTarget(avatar = null) {
    const c = ctx();
    const { pu, cur, list } = await personaInfo();
    const id = avatar || cur || list[0]?.id || null;
    const isCur = !id || id === cur;
    if (isCur && !$('#persona_description').length) {
        toastr.warning('找不到用户人设');
        return null;
    }
    const name = id ? (pu.personas?.[id] ?? c.name1) : c.name1;
    const initial = lf(isCur ? $('#persona_description').val() : pu.persona_descriptions?.[id]?.description);
    const key = id ? `persona:${id}` : `persona:${name}`;
    if (id && !list.some(x => x.id !== id && x.name === name)) await adoptSnaps(`persona:${name}`, key);
    return savedTarget(key, initial, {
        kind: 'persona',
        avatar: id,
        subtitle: escapeHtml(name),
        pickers: `<span class="rs_icon rs_shelf_open fa-solid fa-table-cells-large" data-kind="persona" title="人设书架"></span>${list.length > 1 ? `<select class="rs_pick text_pole" data-pick="persona">${nameOpts(list, id, cur)}</select>` : ''}`,
        save: async text => {
            if (isCur) $('#persona_description').val(text).trigger('input');
            else {
                pu.persona_descriptions = pu.persona_descriptions || {};
                pu.persona_descriptions[id] = { ...(pu.persona_descriptions[id] || {}), description: text };
                c.saveSettingsDebounced();
            }
            await addSnaps(key, initial, text);
            toastr.success('用户人设已保存');
            return true;
        },
    });
}

async function adoptSnaps(from, to) {
    for (const k of [from, 'ver:' + from]) {
        const old = await idbGet(k);
        if (!old?.length) continue;
        const nk = k === from ? to : 'ver:' + to;
        const mine = (await idbGet(nk)) || [];
        await idbPut(nk, k === from ? [...old, ...mine].sort((x, y) => x.time - y.time) : [...old, ...mine]);
        await idbPut(k, []);
    }
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
    const entries = pzWorldList(data || {});

    const bookOpts = names.map(n => `<option ${n === book ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
    if (!entries.length) {
        return {
            kind: 'world',
            pickers: `${WI_FIND}<select class="rs_pick text_pole" data-pick="book">${bookOpts}</select>${WI_DEL}`,
            book,
            refs: [{ label: '打开时', text: '' }], ref: 0, initial: '', empty: '这本世界书还没有条目',
            saveLabel: '保存', closeAfterSave: false, save: async () => false,
        };
    }

    const entry = entries.find(e => String(e.uid) === String(uid)) || entries[0];
    const entryOpts = entries.map(e =>
        `<option value="${e.uid}" ${e === entry ? 'selected' : ''}>${escapeHtml(wiName(e))}${e.disable ? '（已禁用）' : ''}</option>`).join('');
    const initial = lf(entry.content);
    const key = `wi:${book}:${entry.uid}`;

    return savedTarget(key, initial, {
        kind: 'world',
        pickers: `${WI_FIND}<select class="rs_pick text_pole" data-pick="book">${bookOpts}</select>
<select class="rs_pick text_pole" data-pick="entry">${entryOpts}</select>
${wiToggleHtml(!entry.disable)}${WI_DEL}`,
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

const WI_FIND = '<span class="rs_icon rs_wi_find fa-solid fa-magnifying-glass" title="搜索世界书"></span>';

const WI_DEL = '<span class="rs_icon rs_wi_delbook fa-solid fa-trash-can" title="删除这本世界书"></span>';

const wfind = { all: false, seq: 0, timer: 0 };

async function wiRemoveBook(book, data) {
    data = data || await ctx().loadWorldInfo(book);
    if (!data?.entries) return false;
    if (!(await binAdd({ type: 'book', label: book, sub: `${Object.keys(data.entries).length} 个条目`, data: { name: book, data: structuredClone(data) } }))) {
        toastr.error(`「${book}」没能放进回收站，为了安全没有删`);
        return false;
    }
    const wi = await pzWorldApi();
    try {
        return wi?.deleteWorldInfo ? !!(await wi.deleteWorldInfo(book)) : !!(await apiPost('/api/worldinfo/delete', { name: book }))?.ok;
    } catch (e) {
        console.error('[重生成拼接] 删除世界书失败', e);
        return false;
    }
}

async function wiOrphanBooks(gone) {
    const c = ctx();
    const wi = await pzWorldApi();
    const lore = wi?.world_info?.charLore || [];
    const goneNames = new Set(gone.map(x => x.avatar.replace(/\.[^.]+$/, '')));
    const books = new Set(gone.map(x => x.world).filter(Boolean));
    for (const l of lore) if (goneNames.has(l.name)) (l.extraBooks || []).forEach(b => books.add(b));
    if ((c.characters || []).some(x => x?.avatar && !('world' in (x.data?.extensions || {})))) return [];
    const { pu } = await personaInfo();
    const used = new Set([
        ...(c.characters || []).map(x => x?.data?.extensions?.world).filter(Boolean),
        ...lore.filter(l => !goneNames.has(l.name)).flatMap(l => l.extraBooks || []),
        ...(wi?.selected_world_info || []),
        pu.persona_description_lorebook,
        ...Object.values(pu.persona_descriptions || {}).map(d => d?.lorebook),
    ].filter(Boolean));
    const names = worldNames();
    return [...books].filter(b => names.includes(b) && !used.has(b));
}

async function wiDeleteBook() {
    const book = state.target?.kind === 'world' ? state.target.book : null;
    if (!book) return;
    const c = ctx();
    const data = await c.loadWorldInfo(book);
    const n = Object.keys(data?.entries || {}).length;
    const users = (c.characters || []).filter(x => x?.data?.extensions?.world === book).map(x => x.name);
    const tip = users.length ? `\n还绑在 ${users.slice(0, 3).join('、')}${users.length > 3 ? ` 等 ${users.length} 张卡` : ''} 上，删了这些卡就用不到它了。` : '';
    if (!(await askConfirm(`删除世界书「${book}」（${n} 个条目）？会放进回收站，${BIN_DAYS} 天内能恢复。${tip}${isDirty() ? '\n当前条目没保存的改动也会丢掉。' : ''}`))) return;
    if (!data?.entries) return toastr.error('读不到这本世界书，没有删');
    if (!(await wiRemoveBook(book, data))) return toastr.error('没能删除');
    await syncLists(true);
    clearDraft();
    toastr.success(`已删除「${book}」，可在回收站恢复`);
    const next = await worldTarget();
    if (next) showTarget(next);
    else closePanel(true);
}

function wfindToggle() {
    if ($('#rs_panel .rs_wfind').length) return $('#rs_panel .rs_wfind').remove();
    $('#rs_panel .rs_pickers').after(`<div class="rs_wfind">
  <div class="rs_pz_filter"><input type="text" class="rs_wfind_q" placeholder="搜条目名、关键词、内容"><span class="rs_chip rs_wfind_all ${wfind.all ? 'rs_on' : ''}">全部世界书</span></div>
  <div class="rs_wfind_list"></div>
</div>`);
    wfindRender();
    $('#rs_panel .rs_wfind_q').trigger('focus');
}

function wfindSnip(text, q) {
    const t = String(text || '').replace(/\s+/g, ' ');
    const i = q ? t.toLowerCase().indexOf(q) : -1;
    return i < 0 ? t.slice(0, 60) : (i > 15 ? '…' : '') + t.slice(Math.max(0, i - 15), i + 45);
}

async function wfindRender() {
    const seq = ++wfind.seq;
    const q = String($('#rs_panel .rs_wfind_q').val() || '').trim().toLowerCase();
    const cur = state.target?.book;
    const books = wfind.all ? worldNames() : cur ? [cur] : [];
    const rows = [];
    if (wfind.all && q) {
        for (const b of books) if (b.toLowerCase().includes(q)) rows.push({ book: b, name: b, pv: '世界书', isBook: true });
    }
    for (const b of books) {
        const data = await ctx().loadWorldInfo(b);
        if (seq !== wfind.seq) return;
        for (const e of pzWorldList(data || {})) {
            const name = wiName(e);
            const keys = [...(e.key || []), ...(e.keysecondary || [])].join(' ');
            if (q && ![name, keys, e.content].some(x => String(x || '').toLowerCase().includes(q))) continue;
            const hitContent = q && !name.toLowerCase().includes(q) && !keys.toLowerCase().includes(q);
            rows.push({ book: b, uid: e.uid, name, off: e.disable, pv: (wfind.all ? b + ' · ' : '') + wfindSnip(e.content, hitContent ? q : '') });
        }
    }
    const shown = rows.slice(0, 200);
    const here = state.target?.uid;
    $('#rs_panel .rs_wfind_list').html(shown.length ? shown.map(r => `<div class="rs_pz_row rs_wfind_row ${!r.isBook && r.book === cur && String(r.uid) === String(here) ? 'rs_pz_sel' : ''}" data-book="${escapeHtml(r.book)}" ${r.isBook ? '' : `data-uid="${r.uid}"`}>
  <div class="rs_wfind_main"><div class="rs_pz_nm">${r.isBook ? '<i class="fa-solid fa-book"></i> ' : ''}${escapeHtml(r.name)}${r.off ? '<span class="rs_pz_tag">禁用</span>' : ''}</div><div class="rs_pz_pv">${escapeHtml(r.pv)}</div></div>
</div>`).join('') + (rows.length > shown.length ? `<div class="rs_wfind_more">还有 ${rows.length - shown.length} 条，再多打几个字</div>` : '') : '<div class="rs_wfind_more">没找到</div>');
}

async function wfindGo(el) {
    const book = el.dataset.book;
    const uid = el.dataset.uid;
    if (await switchTarget(() => worldTarget(book, uid))) $('#rs_panel .rs_wfind').remove();
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
    eachSentence(text, (_, a, b) => {
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
        eachSentence(text, (_, a, b) => {
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
    out = out.split('\n').filter((line, i) => line.trim() || !(text.split('\n')[i]?.trim())).join('\n');
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
    const box = el.closest('.rs_ref_pane');
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
    const btns = [['ins', '插入'], ['fav', '收藏'], ['copy', '复制']];
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
    if (act === 'ins') {
        spans.each((_, e) => state.used.add(e.dataset.k));
        clearSel();
        insertSentence(text);
        return;
    }
    if (act === 'fav') collect(text, sourceLabel());
    if (act === 'copy') copyText(text);
    clearSel();
}

const tagNames = str => String(str || '').split(/[\s,，、]+/).map(x => x.replace(/[<>/]/g, '').trim()).filter(x => /^[\w-]+$/.test(x));

function readerDisplay(raw, opt = {}) {
    raw = String(raw ?? '');
    const o = {
        hide: 'think thinking',
        body: settings().readerBody,
        code: true,
        md: true,
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

function setFloorText(id, text) {
    const c = ctx();
    const m = c.chat[id];
    m.mes = text;
    if (Array.isArray(m.swipes) && m.swipes.length) m.swipes[m.swipe_id ?? 0] = text;
    c.updateMessageBlock(id, m);
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

const BACK_LONG = 6000;
const BACK_LONG_WAIT = 220;
let backRaf = 0;
let backTimer = 0;
function scheduleBack() {
    cancelAnimationFrame(backRaf);
    clearTimeout(backTimer);
    if ((bodyEl()?.value.length || 0) > BACK_LONG) backTimer = setTimeout(afterEdit, BACK_LONG_WAIT);
    else backRaf = requestAnimationFrame(afterEdit);
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
const isDirty = () => {
    const t = state.target;
    if (!t) return false;
    if (t.kind === 'preset') return !!pz.tgt?.dirty;
    if (t.kind === 'regex') return rx.dirty;
    if (t.kind === 'set' || t.kind === 'bin' || t.kind === 'fav') return false;
    return !!bodyEl() && bodyEl().value !== t.initial;
};

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
        <option value="preset">预设缝合</option>
        <option value="regex">正则</option>
        <option value="fav">收藏</option>
        <option value="bin">回收站</option>
        <option value="set">设置</option>
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
      <div class="rs_icon rs_ver_del fa-solid fa-trash-can" title="删除"></div>
      <div class="rs_icon rs_snap_clear fa-solid fa-broom" title="清空全部存档"></div>
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
    <div class="rs_pz">
      <div class="rs_pz_sec">
        <div class="rs_bar rs_pz_head">
          <span class="rs_pz_label">来源</span>
          <select class="rs_pz_kind text_pole"><option value="cur">当前预设</option><option value="p">其他预设</option><option value="w">世界书</option><option value="f">导入的文件</option></select>
          <select class="rs_pz_src text_pole"></select>
          <label class="rs_icon rs_pz_import fa-solid fa-file-import" title="导入 txt / Word / json"><input type="file" class="rs_pz_file" accept=".txt,.md,.json,.docx,.doc,text/plain,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden></label>
        </div>
        <div class="rs_pz_filter">
          <input type="text" class="rs_pz_q" data-side="src" placeholder="搜索名称或内容">
          <div class="rs_icon rs_pz_foldall fa-solid fa-layer-group" data-side="src" title="全部展开/收起分类"></div>
          <div class="rs_icon rs_pz_all fa-solid fa-check-double" title="全选列表里的"></div>
        </div>
        <div class="rs_pz_cats" data-side="src"></div>
        <div class="rs_pz_list rs_pz_src_list"></div>
      </div>
      <div class="rs_grip"><span></span></div>
      <div class="rs_bar rs_pz_act">
        <span class="rs_pz_count"></span>
        <div class="rs_pz_pos">插到最后</div>
        <div class="menu_button rs_pz_insert">插入</div>
      </div>
      <div class="rs_pz_sec">
        <div class="rs_bar rs_pz_head">
          <span class="rs_pz_label">目标</span>
          <select class="rs_pz_tkind text_pole"><option value="p">预设</option><option value="w">世界书</option></select>
          <select class="rs_pz_tgt text_pole"></select>
          <div class="rs_icon rs_pz_undo fa-solid fa-rotate-left" title="撤回"></div>
          <div class="rs_icon rs_pz_redo fa-solid fa-rotate-right" title="重做"></div>
          <div class="menu_button rs_pz_save">保存</div>
        </div>
        <div class="rs_pz_filter">
          <input type="text" class="rs_pz_q" data-side="tgt" placeholder="搜索名称或内容">
          <div class="rs_icon rs_pz_foldall fa-solid fa-layer-group" data-side="tgt" title="全部展开/收起分类"></div>
          <div class="rs_icon rs_pz_tokbtn fa-solid fa-chart-simple" title="统计 token"></div>
          <div class="rs_icon rs_pz_schbtn fa-solid fa-sliders" title="开关方案"></div>
        </div>
        <div class="rs_pz_tokbar"></div>
        <div class="rs_pz_tokopts"><span class="rs_chip rs_pz_toksort">按 token 从多到少排</span></div>
        <div class="rs_pz_cats" data-side="tgt"></div>
        <div class="rs_pz_list rs_pz_tgt_list" data-drop="pz"></div>
      </div>
      <div class="rs_pz_sch">
        <div class="rs_bar"><div class="rs_bar_title rs_pz_sch_title"></div><div class="rs_icon rs_pz_sch_close fa-solid fa-xmark" title="关闭"></div></div>
        <div class="rs_pz_sch_new menu_button">把现在的开关存成新方案</div>
        <div class="rs_pz_list rs_pz_sch_list"></div>
      </div>
      <div class="rs_pz_pick">
        <div class="rs_bar"><div class="rs_bar_title">插在哪条后面</div><div class="rs_icon rs_pz_pick_close fa-solid fa-xmark" title="关闭"></div></div>
        <div class="rs_pz_filter"><input type="text" class="rs_pz_q" data-side="pick" placeholder="搜索条目"></div>
        <div class="rs_pz_list rs_pz_pick_list"></div>
      </div>
    </div>
    <div class="rs_set"></div>
    <div class="rs_shelf">
      <div class="rs_bar"><span class="rs_icon rs_shelf_back fa-solid fa-chevron-left" title="返回"></span><div class="rs_bar_title rs_shelf_title"></div><div class="rs_bar_spacer"></div><span class="rs_icon rs_shelf_view fa-solid fa-list" title="切换网格/列表"></span><span class="rs_pz_card_btn rs_shelf_selbtn">选择</span></div>
      <div class="rs_shelf_tabs rs_rx_tabs"></div>
      <div class="rs_pz_filter"><input type="text" class="rs_shelf_q" placeholder="搜索名字"></div>
      <div class="rs_shelf_head"></div>
      <div class="rs_shelf_grid"></div>
      <div class="rs_bar rs_shelf_bulk"><span class="rs_pz_card_btn" data-b="all">全选</span><span class="rs_shelf_bcount"></span><div class="rs_bar_spacer"></div><span class="rs_pz_card_btn" data-b="move">移动</span><span class="rs_pz_card_btn rs_pz_card_del" data-b="del">删除</span><span class="rs_pz_card_btn" data-b="more">更多</span></div>
      <div class="rs_shelf_sheet"></div>
      <input type="file" class="rs_shelf_file" accept="image/*" hidden>
    </div>
    <div class="rs_bin"></div>
    <div class="rs_fav"></div>
    <div class="rs_rx">
      <div class="rs_bar rs_pz_head">
        <div class="rs_rx_tabs"><span data-t="g">全局</span><span data-t="p">预设</span><span data-t="c">角色</span></div>
        <div class="rs_bar_spacer"></div>
        <div class="rs_icon rs_rx_undo fa-solid fa-rotate-left" title="撤回"></div>
        <div class="rs_icon rs_rx_redo fa-solid fa-rotate-right" title="重做"></div>
        <div class="menu_button rs_rx_save">保存</div>
      </div>
      <div class="rs_bar rs_rx_namebar"><div class="rs_pickbtn rs_rx_scope"></div></div>
      <div class="rs_pz_filter"><input type="text" class="rs_rx_q" placeholder="搜索名称或表达式"><div class="rs_icon rs_rx_all fa-solid fa-check-double" title="全选列表里的"></div><label class="rs_icon rs_pz_import fa-solid fa-file-import" title="导入正则 json"><input type="file" class="rs_rx_file" accept=".json,application/json" multiple hidden></label><div class="rs_icon rs_rx_add fa-solid fa-plus" title="新建"></div></div>
      <div class="rs_bar rs_pz_act rs_rx_act">
        <span class="rs_pz_count rs_rx_count"></span>
        <div class="rs_pickbtn rs_rx_bmove">移到…</div>
        <div class="menu_button rs_rx_bdel">删除</div>
        <div class="rs_icon rs_rx_bclear fa-solid fa-xmark" title="取消选择"></div>
      </div>
      <div class="rs_pz_list rs_rx_list" data-drop="rx"></div>
      <div class="rs_rx_ed"></div>
      <div class="rs_rx_pick">
        <div class="rs_bar"><div class="rs_bar_title rs_rx_pick_title"></div><div class="rs_icon rs_rx_pick_close fa-solid fa-xmark" title="关闭"></div></div>
        <div class="rs_pz_filter"><input type="text" class="rs_rx_pick_q" placeholder="搜索预设或角色"></div>
        <div class="rs_pz_list rs_rx_pick_list"></div>
      </div>
    </div>
    <div class="rs_body_wrap">
      <div class="rs_body_back" aria-hidden="true"></div>
      <textarea class="rs_body_text" spellcheck="false"></textarea>
    </div>
  </div>
</div>`);
    bodyEl().addEventListener('scroll', syncBackScroll, { passive: true });
    applyLook();
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
    const pzSec = $('#rs_panel .rs_pz > .rs_pz_sec').first();
    if (pzSec.is(':visible')) {
        const pr = Math.min(0.8, Math.max(0.15, Number(settings().pzRatio) || DEFAULTS.pzRatio));
        pzSec.css('height', Math.round(pzSec.parent().height() * pr) + 'px');
    }
    const ratio = Math.min(0.8, Math.max(0.15, Number(settings().splitRatio) || DEFAULTS.splitRatio));
    const r = $('#rs_overlay').hasClass('rs_kb') ? Math.min(ratio, KEYBOARD_REF_RATIO) : ratio;
    $('#rs_panel .rs_ref_pane').css('height', Math.round($('#rs_panel').height() * r) + 'px');
}

function showTarget(t) {
    shelfClose();
    if (!t) return;
    ensureShell();
    clearSel();
    if (state.target?.kind === 'preset' && t.kind !== 'preset') pzReset();
    if (state.target?.kind === 'regex' && t.kind !== 'regex') rxReset();
    $('#rs_panel').toggleClass('rs_mode_preset', t.kind === 'preset').toggleClass('rs_mode_regex', t.kind === 'regex')
        .toggleClass('rs_mode_set', t.kind === 'set').toggleClass('rs_mode_bin', t.kind === 'bin').toggleClass('rs_mode_fav', t.kind === 'fav');
    if (t.kind === 'set' || t.kind === 'bin' || t.kind === 'fav') {
        state.target = t;
        $('#rs_panel .rs_kind').val(t.kind);
        $('#rs_panel .rs_title').text(t.subtitle);
        if (t.kind === 'set') renderSettings();
        else if (t.kind === 'fav') {
            fav.open = null;
            favRender();
        } else binRender();
        return;
    }
    if (t.kind === 'preset' || t.kind === 'regex') {
        state.target = t;
        $('#rs_panel .rs_kind').val(t.kind);
        $('#rs_panel .rs_title').text(t.subtitle);
        if (settings().lastKind !== t.kind) {
            settings().lastKind = t.kind;
            ctx().saveSettingsDebounced();
        }
        if (t.kind === 'preset') openStitch();
        else openRegex();
        return;
    }
    Object.assign(state, { target: t, ref: t.ref, used: new Set(), caret: null, undo: [], redo: [], typing: false });

    $('#rs_panel .rs_title').html(t.subtitle || '');
    $('#rs_panel .rs_kind').val(t.kind);
    if (settings().lastKind !== t.kind) {
        settings().lastKind = t.kind;
        ctx().saveSettingsDebounced();
    }
    $('#rs_panel .rs_wfind').remove();
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
        if (!(await askConfirm('有改动还没保存，切换会丢掉，继续吗？'))) return false;
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
    const t = state.target;
    const r = t?.refs[state.ref];
    const title = r?.verId ? '删除这个版本' : r?.snapIdx !== undefined ? '删除这个存档' : '删除这一楼的这个版本';
    $('#rs_panel .rs_ver_del').toggle(!!r && (!!r.verId || r.snapIdx !== undefined || r.swipe !== undefined)).attr('title', title);
    $('#rs_panel .rs_snap_clear').toggle(!!t?.refs.some(x => x.snapIdx !== undefined));
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
    if (!r) return;
    if (r.verId) {
        if (!(await askConfirm(`删除版本「${r.label.replace(/^★ /, '')}」？可以在回收站找回`))) return;
        const vers = await getVers(t.key);
        await binAdd(vers.filter(v => v.id === r.verId).map(v => ({ type: 'ver', label: r.label.replace(/^★ /, ''), sub: unHtml(t.subtitle), data: { key: t.key, item: v } })));
        await putVers(t.key, vers.filter(v => v.id !== r.verId));
        toastr.success('版本已删除');
    } else if (r.snapIdx !== undefined) {
        if (!(await askConfirm(`删除「${r.label}」？可以在回收站找回`))) return;
        const arr = await getSnaps(t.key);
        if (arr[r.snapIdx]?.time === r.time) {
            await binAdd({ type: 'snap', label: r.label, sub: unHtml(t.subtitle), data: { key: t.key, items: arr.slice(r.snapIdx, r.snapIdx + 1) } });
            arr.splice(r.snapIdx, 1);
        }
        await idbPut(t.key, arr);
        toastr.success('存档已删除');
    } else if (r.swipe !== undefined) {
        if (!(await askConfirm(`从聊天里删掉这一楼的「${r.label}」？可以在回收站找回`))) return;
        if (!(await deleteSwipe(t.id, r.swipe))) return;
        const fresh = msgTarget(t.id);
        t.refs = fresh.refs;
        state.ref = Math.min(state.ref, t.refs.length - 1);
        state.used = new Set();
        fillRefSelect(state.ref);
        updateRefButtons();
        renderRef();
        renderBack();
        toastr.success('已删除');
        return;
    } else return;
    state.ref = 0;
    await refreshRefs();
}

async function clearSnaps() {
    const t = state.target;
    const n = t?.refs.filter(x => x.snapIdx !== undefined).length;
    if (!n || !(await askConfirm(`清空这一项的全部存档？收藏的★版本会保留，清掉的可以在回收站找回`))) return;
    await binAdd({ type: 'snap', label: `全部存档（${n} 个）`, sub: unHtml(t.subtitle), data: { key: t.key, items: await getSnaps(t.key) } });
    await idbPut(t.key, []);
    state.ref = 0;
    await refreshRefs();
    toastr.success('存档已清空');
}

async function deleteSwipe(id, i) {
    const c = ctx();
    const msg = c.chat[id];
    if (!msg || !Array.isArray(msg.swipes) || msg.swipes.length < 2 || i === msg.swipe_id) return false;
    await binAdd({
        type: 'swipe',
        label: String(msg.swipes[i] || '').replace(/\s+/g, ' ').slice(0, BIN_PREVIEW),
        sub: `${msg.name || ''} · 第 ${id} 楼`,
        data: { chat: c.getCurrentChatId?.(), mes: id, text: msg.swipes[i], info: msg.swipe_info?.[i] ?? null },
    });
    msg.swipes.splice(i, 1);
    if (Array.isArray(msg.swipe_info)) msg.swipe_info.splice(i, 1);
    if (i < msg.swipe_id) msg.swipe_id--;
    refreshSwipeUI(id, msg);
    await c.saveChat();
    return true;
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

const GRIP_KEYS = { rs_ref_pane: 'splitRatio', rs_pz_sec: 'pzRatio' };

function onGripDown(e, grip) {
    const el = grip.previousElementSibling;
    const key = Object.keys(GRIP_KEYS).find(c => el.classList.contains(c));
    gripDrag = { y: e.clientY, h: el.offsetHeight, el, total: el.parentElement.offsetHeight, key: GRIP_KEYS[key] };
    grip.setPointerCapture?.(e.pointerId);
}
function onGripMove(e) {
    const d = gripDrag;
    if (!d) return;
    d.el.style.height = Math.min(d.total * 0.8, Math.max(d.total * 0.15, d.h + e.clientY - d.y)) + 'px';
}
function onGripUp() {
    const d = gripDrag;
    if (!d) return;
    gripDrag = null;
    if (d.key === 'splitRatio' && $('#rs_overlay').hasClass('rs_kb')) return;
    settings()[d.key] = d.el.offsetHeight / d.el.parentElement.offsetHeight;
    ctx().saveSettingsDebounced();
}

const DRAG_EDGE = 44;
const DRAG_SPEED = 12;
let rowDrag = null;

function onDragDown(e, handle) {
    const row = handle.closest('[data-k]');
    if (!row) return;
    e.preventDefault();
    rowDrag = { row, list: row.parentElement, over: null, after: false, y: e.clientY, raf: 0 };
    row.classList.add('rs_dragging');
    handle.setPointerCapture?.(e.pointerId);
}

function dragMark() {
    const d = rowDrag;
    let over = null;
    let after = false;
    for (const el of d.list.querySelectorAll(':scope > [data-k]')) {
        const b = el.getBoundingClientRect();
        over = el;
        after = d.y >= b.top + b.height / 2;
        if (!after) break;
    }
    d.list.querySelectorAll('.rs_drop_before, .rs_drop_after').forEach(el => el.classList.remove('rs_drop_before', 'rs_drop_after'));
    if (over === d.row) over = null;
    if (over) over.classList.add(after ? 'rs_drop_after' : 'rs_drop_before');
    Object.assign(d, { over, after });
}

function dragScroll() {
    const d = rowDrag;
    if (!d) return;
    const b = d.list.getBoundingClientRect();
    const edge = Math.min(DRAG_EDGE, b.height / 6);
    const v = d.y < b.top + edge ? -DRAG_SPEED : d.y > b.bottom - edge ? DRAG_SPEED : 0;
    if (!v) {
        d.raf = 0;
        return;
    }
    d.list.scrollTop += v;
    dragMark();
    d.raf = requestAnimationFrame(dragScroll);
}

function onDragMove(e) {
    const d = rowDrag;
    if (!d) return;
    d.y = e.clientY;
    dragMark();
    if (!d.raf) d.raf = requestAnimationFrame(dragScroll);
}

function onDragUp() {
    const d = rowDrag;
    if (!d) return;
    rowDrag = null;
    cancelAnimationFrame(d.raf);
    d.row.classList.remove('rs_dragging');
    d.over?.classList.remove('rs_drop_before', 'rs_drop_after');
    if (d.over) DROPS[d.list.dataset.drop]?.(d.row.dataset.k, d.over.dataset.k, d.after);
}

async function closePanel(force = false, keepDraft = false) {
    if (!force && isDirty() && !(await askConfirm('有改动还没保存，确定关闭吗？'))) return;
    pzReset();
    rxReset();
    shelfClose();
    if (keepDraft) saveDraftNow();
    else clearDraft();
    clearTimeout(state.typingTimer);
    clearTimeout(state.diffTimer);
    clearTimeout(backTimer);
    cancelAnimationFrame(backRaf);
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
    if (t.kind === 'char') showTarget(await charTarget(t.field, t.avatar));
    else if (t.kind === 'persona') showTarget(await personaTarget(t.avatar));
    else if (t.kind === 'world') showTarget(await worldTarget(t.book, $('#rs_panel .rs_pick[data-pick="entry"]').val()));
}

function openPanel(id) {
    showTarget(msgTarget(id));
}

const PZ_PREVIEW = 46;
const PZ_UNDO = 50;
const PZ_CARD_MIN = 160;
const PZ_DIVIDER = /[━═─—–=~～☆★◆◇■□●○◎▼▲◀▶✦✧❖❀✿♡♥·•*#-]{2,}/;
const PZ_DECOR = /[━═─—–=~～☆★◆◇■□●○◎▼▲◀▶✦✧❖❀✿♡♥·•*#【】\[\]〔〕「」『』┌┐└┘├┤┬┴┼│┃‖║╔╗╚╝╠╣═╭╮╰╯|-]+/g;
const PZ_ROLES = [['system', '系统'], ['user', '用户'], ['assistant', 'AI']];

const pz = { src: null, tgt: null, files: [], last: {}, sel: new Set(), tl: [], open: new Set(), hunks: {}, catf: {}, tokOn: false, tokSort: false, tokCache: new Map(), sch: false, cmpTimer: 0, unfold: new Set(), pos: 'end', picking: false, editing: null };

const pzNorm = s => String(s ?? '').replace(/\r\n?/g, '\n').trim();
const pzUid = () => crypto.randomUUID?.() || 'pz-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

async function pzPM() {
    let pm = null;
    try { pm = ctx().getPresetManager?.('openai') || null; } catch { }
    if (!pm) {
        try { pm = (await import('/scripts/preset-manager.js')).getPresetManager('openai'); } catch { }
    }
    return pm && typeof pm.getPresetList === 'function' ? pm : null;
}

async function pzLive(pm) {
    const s = pm?.getPresetList?.().settings || ctx().chatCompletionSettings;
    if (s) return s;
    try { return (await import('/scripts/openai.js')).oai_settings || null; } catch { return null; }
}

function pzNames(pm) {
    const { preset_names } = pm.getPresetList();
    return Array.isArray(preset_names) ? [...preset_names] : Object.keys(preset_names || {});
}

function pzStored(pm, name) {
    const { presets, preset_names } = pm.getPresetList();
    const idx = Array.isArray(preset_names) ? preset_names.indexOf(name) : preset_names?.[name];
    return idx === undefined || idx < 0 || !presets?.[idx] ? null : { idx, preset: presets[idx] };
}

function pzOrder(preset, create = true) {
    if (!Array.isArray(preset.prompt_order)) {
        if (!create) return null;
        preset.prompt_order = [];
    }
    let o = preset.prompt_order.find(x => String(x.character_id) === '100001') || preset.prompt_order[0];
    if (!o) {
        if (!create) return null;
        o = { character_id: 100001, order: [] };
        preset.prompt_order.push(o);
    }
    if (!Array.isArray(o.order)) o.order = [];
    return o;
}

function pzEntry(p, enabled, inOrder) {
    return {
        key: 'p:' + p.identifier,
        id: p.identifier,
        name: String(p.name ?? p.identifier ?? ''),
        role: p.role || 'system',
        content: String(p.content ?? ''),
        raw: p,
        enabled,
        inOrder,
        marker: !!p.marker,
    };
}

function pzFromPreset(preset) {
    const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
    const order = (preset && pzOrder(preset, false)?.order) || [];
    const byId = new Map(prompts.map(p => [p.identifier, p]));
    const seen = new Set();
    const list = [];
    order.forEach(o => {
        const p = byId.get(o.identifier);
        if (!p || seen.has(p.identifier)) return;
        seen.add(p.identifier);
        list.push(pzEntry(p, o.enabled !== false, true));
    });
    prompts.forEach(p => {
        if (!seen.has(p.identifier)) list.push(pzEntry(p, false, false));
    });
    return pzClassify(list);
}

let pzDivCache = { src: null, rules: [] };

function pzDivRules() {
    const src = String(settings().pzDividers || '');
    if (pzDivCache.src === src) return pzDivCache.rules;
    const rules = src.split('\n').map(x => x.trim()).filter(Boolean).map(line => {
        const m = line.match(/^\/(.+)\/([a-z]*)$/);
        if (!m) return { text: line };
        try { return { re: new RegExp(m[1], m[2].replace(/[gy]/g, '')) }; } catch { return null; }
    }).filter(Boolean);
    pzDivCache = { src, rules };
    return rules;
}

const pzIsDivider = e => !e.marker && (PZ_DIVIDER.test(e.name) || pzDivRules().some(r => (r.re ? r.re.test(e.name) : e.name.includes(r.text))));
const pzCatName = n => pzDivRules().reduce((t, r) => (r.text ? t.split(r.text).join(' ') : t), n).replace(PZ_DECOR, ' ').replace(/[\p{Extended_Pictographic}️‍⬇⬆↓↑▽△]/gu, ' ').replace(/\s+/g, ' ').trim();

function pzClassify(list) {
    let group = '';
    list.forEach(e => {
        e.div = pzIsDivider(e);
        e.end = false;
        if (e.div) {
            const name = pzCatName(e.name) || e.name.trim();
            const closing = /结束|^<\//.test(name) || /^\s*<\//.test(e.content);
            if (group && (closing || name.replace(/结束$/, '').trim() === group)) {
                Object.assign(e, { div: false, end: true, cat: group });
                group = '';
                return;
            }
            if (closing) e.div = false;
            else group = name;
        }
        e.cat = group;
    });
    return list;
}

function pzMaps(list) {
    const byId = new Map();
    const byName = new Map();
    list.forEach(e => {
        if (e.id && !byId.has(e.id)) byId.set(e.id, e);
        const n = e.name.trim();
        if (n && !byName.has(n)) byName.set(n, e);
    });
    return { byId, byName };
}

const pzFind = (e, maps) => (e.id && maps.byId.get(e.id)) || maps.byName.get(e.name.trim()) || null;
const pzSame = (a, b) => pzNorm(a.content) === pzNorm(b.content) && a.name.trim() === b.name.trim();

async function pzUnzip(buf, path) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('不是有效的 Word 文档');
    const dec = new TextDecoder();
    let off = dv.getUint32(eocd + 16, true);
    for (let n = dv.getUint16(eocd + 10, true); n > 0; n--) {
        if (dv.getUint32(off, true) !== 0x02014b50) break;
        const method = dv.getUint16(off + 10, true);
        const size = dv.getUint32(off + 20, true);
        const nlen = dv.getUint16(off + 28, true);
        const elen = dv.getUint16(off + 30, true);
        const clen = dv.getUint16(off + 32, true);
        const local = dv.getUint32(off + 42, true);
        if (dec.decode(new Uint8Array(buf, off + 46, nlen)) === path) {
            const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
            const data = new Uint8Array(buf, start, size);
            if (method === 0) return dec.decode(data);
            if (typeof DecompressionStream !== 'function') throw new Error('这个浏览器读不了 Word，请另存为 txt 再导入');
            const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
            return dec.decode(out);
        }
        off += 46 + nlen + elen + clen;
    }
    return null;
}

async function pzDocxText(buf) {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const val = el => el?.getAttributeNS(W, 'val') ?? el?.getAttribute('w:val') ?? '';
    const xml = await pzUnzip(buf, 'word/document.xml');
    if (!xml) throw new Error('不是有效的 Word 文档');
    const levels = new Map();
    const styles = await pzUnzip(buf, 'word/styles.xml').catch(() => null);
    if (styles) {
        const sd = new DOMParser().parseFromString(styles, 'application/xml');
        for (const st of sd.getElementsByTagNameNS(W, 'style')) {
            const id = st.getAttributeNS(W, 'styleId') ?? st.getAttribute('w:styleId');
            const nm = val(st.getElementsByTagNameNS(W, 'name')[0]).toLowerCase();
            const ol = st.getElementsByTagNameNS(W, 'outlineLvl')[0];
            const m = nm.match(/^(?:heading|标题)\s*(\d)$/);
            const lv = m ? Number(m[1]) : ol ? Number(val(ol)) + 1 : 0;
            if (id && lv) levels.set(id, lv);
        }
    }
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const out = [];
    for (const p of doc.getElementsByTagNameNS(W, 'p')) {
        let text = '';
        for (const n of p.getElementsByTagNameNS(W, '*')) {
            if (n.localName === 't') text += n.textContent;
            else if (n.localName === 'tab') text += '\t';
            else if (n.localName === 'br' || n.localName === 'cr') text += '\n';
        }
        const ol = p.getElementsByTagNameNS(W, 'outlineLvl')[0];
        const lv = levels.get(val(p.getElementsByTagNameNS(W, 'pStyle')[0])) || (ol ? Number(val(ol)) + 1 : 0);
        out.push(lv && lv <= 6 && text.trim() ? '#'.repeat(lv) + ' ' + text.trim() : text);
    }
    return out.join('\n');
}

const wiName = (w, i) => String(w.comment || (Array.isArray(w.key) && w.key.join('、')) || `条目 ${w.uid ?? i}`);

function pzWorldEntries(entries, prefix) {
    return pzWorldList({ entries })
        .map((e, i) => ({
            key: `${prefix}${e.uid ?? i}`,
            id: null,
            name: wiName(e, i),
            role: 'system',
            content: String(e.content ?? ''),
            raw: null,
            wraw: e,
            enabled: !e.disable,
        }));
}

async function pzReadFile(file) {
    const ext = String(file.name).split('.').pop().toLowerCase();
    if (ext === 'doc') throw new Error('不支持旧版 .doc，请在 Word 里另存为 .docx 或 .txt');
    const buf = await file.arrayBuffer();
    if (ext === 'docx') return { text: await pzDocxText(buf) };
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
        text = new TextDecoder('gbk').decode(buf);
    }
    text = text.replace(/^﻿/, '');
    if (ext === 'json' || /^\s*[{[]/.test(text)) {
        let obj = null;
        try { obj = JSON.parse(text); } catch { }
        if (Array.isArray(obj?.prompts)) return { entries: pzFromPreset(obj) };
        if (obj?.entries && typeof obj.entries === 'object') return { entries: pzWorldEntries(obj.entries, 'f:') };
        if (Array.isArray(obj)) {
            return {
                entries: obj.filter(x => x && typeof x === 'object').map((x, i) => ({
                    key: `f:${i}`, id: null, raw: null, enabled: true, role: x.role || 'system',
                    name: String(x.name ?? x.comment ?? x.title ?? `条目 ${i + 1}`),
                    content: String(x.content ?? x.text ?? ''),
                })),
            };
        }
    }
    return { text };
}

function pzBuildFileSource(i) {
    const f = pz.files[i];
    const list = f.entries || (pzNorm(f.text) ? [{ name: f.name.replace(/\.[^.]+$/, ''), content: pzNorm(f.text) }] : []);
    pz.src = {
        v: 'f:' + i,
        entries: pzClassify(list.map((e, j) => (e.key ? e : { key: `f:${i}:${j}`, id: null, role: 'system', raw: null, enabled: true, ...e }))),
    };
}

async function pzLoadFile(file) {
    try {
        const r = await pzReadFile(file);
        const f = { name: file.name, ...r };
        let i = pz.files.findIndex(x => x.name === f.name);
        if (i < 0) i = pz.files.push(f) - 1;
        else pz.files[i] = f;
        pz.sel.clear();
        pzBuildFileSource(i);
        await pzFillSelects();
        pzRender();
        toastr.success(f.text ? `读到「${file.name}」` : `读到 ${pz.src.entries.length} 条`);
    } catch (e) {
        toastr.error(e?.message || '读取文件失败');
    }
}

async function pzSetSource(v) {
    const pm = await pzPM();
    pz.sel.clear();
    if (v.startsWith('f:')) {
        if (pz.files[v.slice(2)]) pzBuildFileSource(Number(v.slice(2)));
        else pz.src = { v: 'f:', entries: [] };
    } else if (v === 'cur') {
        const live = await pzLive(pm);
        pz.src = { v, entries: pzFromPreset({ prompts: live?.prompts || [], prompt_order: live?.prompt_order || [] }) };
    } else if (v === 'p:' || v === 'w:') {
        pz.src = { v, entries: [] };
    } else if (v.startsWith('p:')) {
        pz.src = { v, entries: pzFromPreset(pzStored(pm, v.slice(2))?.preset || {}) };
    } else if (v.startsWith('w:')) {
        const data = await ctx().loadWorldInfo(v.slice(2));
        pz.src = { v, entries: pzClassify(pzWorldEntries(data?.entries, 'w:')) };
    }
}

async function pzSetTarget(name, type = pz.tgt?.type || 'p') {
    if (type === 'w') {
        const data = structuredClone(await ctx().loadWorldInfo(name));
        if (!data?.entries) {
            toastr.warning('读不到这本世界书');
            return false;
        }
        pz.tgt = { type, name, data, undo: [], redo: [], dirty: false };
        return true;
    }
    const preset = await pzLoadPreset(name);
    if (!preset) {
        toastr.warning('找不到这个预设');
        return false;
    }
    pz.tgt = { type, name, data: preset, undo: [], redo: [], dirty: false };
    return true;
}

async function pzLoadPreset(name) {
    const pm = await pzPM();
    const st = pm && pzStored(pm, name);
    if (!st) return null;
    const preset = structuredClone(st.preset);
    if (name === pm.getSelectedPresetName()) {
        const live = await pzLive(pm);
        if (Array.isArray(live?.prompts)) {
            preset.prompts = structuredClone(live.prompts);
            preset.prompt_order = structuredClone(live.prompt_order || []);
        }
    }
    if (!Array.isArray(preset.prompts)) preset.prompts = [];
    return preset;
}

const pzIsWorld = () => pz.tgt?.type === 'w';

function pzWorldList(data) {
    return Object.values(data.entries || {}).sort((a, b) => (a.displayIndex ?? a.uid) - (b.displayIndex ?? b.uid));
}

function pzFromWorld(data) {
    return pzClassify(pzWorldList(data).map(w => ({
        key: 'w:' + w.uid,
        id: String(w.uid),
        name: wiName(w),
        role: 'system',
        content: String(w.content ?? ''),
        raw: null,
        wraw: w,
        enabled: !w.disable,
        inOrder: true,
        marker: false,
    })));
}

function pzTgtEntries() {
    if (!pz.tgt) return [];
    return pzIsWorld() ? pzFromWorld(pz.tgt.data) : pzFromPreset(pz.tgt.data);
}

function pzReorderWorld(ids) {
    const ents = pz.tgt.data.entries;
    ids.forEach((id, i) => { if (ents[id]) ents[id].displayIndex = i; });
}
async function pzFillSelects() {
    const pm = await pzPM();
    const names = pzNames(pm);
    const cur = pm.getSelectedPresetName();
    const opt = (v, t) => `<option value="${escapeHtml(v)}">${escapeHtml(t)}</option>`;
    const v = pz.src?.v || 'cur';
    const kind = v === 'cur' ? 'cur' : v.slice(0, 1);
    const lists = {
        p: names.filter(n => n !== cur).map(n => opt('p:' + n, n)),
        w: worldNames().map(n => opt('w:' + n, n)),
        f: pz.files.map((f, i) => opt('f:' + i, f.name)),
    };
    $('#rs_panel .rs_pz_kind').val(kind);
    $('#rs_panel .rs_pz_src').toggle(kind !== 'cur')
        .html(kind === 'cur' ? '' : lists[kind].join('') || `<option value="">${{ p: '没有其他预设', w: '没有世界书', f: '还没导入文件' }[kind]}</option>`)
        .val(kind === 'cur' ? '' : v);
    const tt = pz.tgt?.type || 'p';
    $('#rs_panel .rs_pz_tkind').val(tt);
    $('#rs_panel .rs_pz_tgt').html(tt === 'w'
        ? worldNames().map(n => opt(n, n)).join('')
        : names.map(n => opt(n, n + (n === cur ? '（当前）' : ''))).join('')).val(pz.tgt?.name || '');
}

async function pzSetKind(kind) {
    if (pz.src?.v && pz.src.v !== 'cur') pz.last[pz.src.v.slice(0, 1)] = pz.src.v;
    let v = 'cur';
    if (kind !== 'cur') {
        const pm = await pzPM();
        const cur = pm.getSelectedPresetName();
        const first = { p: pzNames(pm).find(n => n !== cur), w: worldNames()[0], f: pz.files.length ? pz.files.length - 1 : undefined }[kind];
        v = pz.last[kind] || (first === undefined ? kind + ':' : kind + ':' + first);
        if (kind === 'f' && !pz.files[v.slice(2)]) v = first === undefined ? 'f:' : 'f:' + first;
    }
    await pzSetSource(v);
    await pzFillSelects();
    pzRender();
}

const pzQuery = side => String($(`#rs_panel .rs_pz_q[data-side="${side}"]`).val() || '').trim().toLowerCase();
const pzHit = (e, q) => !q || e.name.toLowerCase().includes(q) || e.content.toLowerCase().includes(q);

function pzFilter(list, side) {
    const q = pzQuery(side);
    return list.filter(e => pzHit(e, q));
}

function pzGroupSize(list, i) {
    let n = 0;
    for (let j = i + 1; j < list.length && !list[j].div && list[j].cat === list[i].cat; j++) {
        n++;
        if (list[j].end) break;
    }
    return n;
}

function pzVisible(list, side, foldKey) {
    const q = pzQuery(side);
    if (q) return list.filter(e => pzHit(e, q)).map(e => ({ e, flat: true }));
    if (side === 'tgt' && pz.tokOn && pz.tokSort) return list.filter(e => !e.div && !e.marker).sort((a, b) => (pzTokOf(b) || 0) - (pzTokOf(a) || 0)).map(e => ({ e, flat: true }));
    const ck = pz.catf[side];
    const ci = ck ? list.findIndex(e => e.key === ck && e.div) : -1;
    if (ci >= 0) {
        const n = pzGroupSize(list, ci);
        return [{ e: list[ci], n, open: true }, ...list.slice(ci + 1, ci + 1 + n).map(e => ({ e }))];
    }
    const out = [];
    let open = true;
    let left = 0;
    list.forEach((e, i) => {
        if (e.div) {
            open = pz.unfold.has(foldKey + e.key);
            left = pzGroupSize(list, i);
            out.push({ e, n: left, open });
        } else if (left > 0) {
            left--;
            if (open) out.push({ e });
        } else out.push({ e });
    });
    return out;
}

function pzRowHtml(e, side, other, x = {}) {
    const st = other ? (pzSame(other, e) ? 'same' : 'diff') : side === 'src' ? 'new' : '';
    const sel = side === 'src' && pz.sel.has(e.key);
    const tag = st ? `<span class="rs_pz_tag rs_pz_${st}">${{ new: '新', diff: '不同', same: '相同' }[st]}</span>` : '';
    const cat = x.flat && e.cat && !e.div ? `<span class="rs_pz_cat_tag">${escapeHtml(e.cat)}</span>` : '';
    const count = e.div && !x.flat ? `<span class="rs_pz_cnt">${x.n} 条</span>` : '';
    const fold = e.div && !x.flat ? `<span class="rs_pz_fold fa-solid ${x.open ? 'fa-chevron-down' : 'fa-chevron-right'}"></span>` : '';
    const pv = e.marker ? '系统占位，没有内容' : e.content.replace(/\s+/g, ' ').trim().slice(0, PZ_PREVIEW);
    const lead = side === 'src' ? '<span class="rs_cb_hit"><span class="rs_cb"></span></span>' : '<span class="rs_drag fa-solid fa-grip-lines" title="按住拖动排序"></span>';
    const divEdit = e.div && !x.flat ? '<span class="rs_icon rs_pz_divedit fa-solid fa-pen" title="查看/编辑这条"></span>' : '';
    const radio = side === 'tgt' && e.div && !x.flat ? `<span class="rs_pz_radio${pzRadioOn(e.cat) ? ' rs_on' : ''}" title="单选：这一类只能开一条">单选</span>` : '';
    const tok = side === 'tgt' && pz.tokOn ? pzTokTag(e, x) : '';
    const tail = side === 'src' ? divEdit : `${radio}${divEdit}${e.inOrder ? '<span class="rs_pz_here" title="插到这条后面">插到这后</span>' : ''}<span class="rs_icon rs_pz_toggle fa-solid ${e.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}" title="启用或关闭"></span>`;
    const cls = ['rs_pz_row', e.div && 'rs_pz_div', sel && 'rs_pz_sel', side === 'tgt' && !e.enabled && 'rs_pz_off'].filter(Boolean).join(' ');
    return `<div class="${cls}">${lead}${fold}<div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(e.name || '（无名）')}</span>${count}${tok}${tag}${cat}</div>${pv && !pz.open.has(side + e.key) ? `<div class="rs_pz_pv">${escapeHtml(pv)}</div>` : ''}</div>${tail}</div>`;
}

function pzCmpHtml(e, side, other) {
    return side === 'tgt' ? pzDiffHtml(e.content, other.content, side + e.key) : pzDiffHtml(other.content, e.content, side + e.key);
}

function pzCardHtml(e, side, other) {
    const roles = PZ_ROLES.map(([v, t]) => `<option value="${v}" ${e.role === v ? 'selected' : ''}>${t}</option>`).join('');
    const showRole = !(side === 'tgt' && pzIsWorld());
    const differs = other && !e.marker && pzNorm(other.content) !== pzNorm(e.content);
    const same = other && !e.marker && !differs;
    return `<div class="rs_pz_card">
  <div class="rs_pz_card_row"><input type="text" class="rs_pz_cf" data-f="name" value="${escapeHtml(e.name)}" placeholder="条目名称">${showRole ? `<select class="rs_pz_cf text_pole" data-f="role">${roles}</select>` : ''}</div>
  <textarea class="rs_pz_cf rs_pz_ct" data-f="content" spellcheck="false" ${e.marker ? 'readonly placeholder="系统占位条目，内容由酒馆自动填入"' : ''}>${escapeHtml(e.content)}</textarea>
  ${differs ? `<div class="rs_pz_cmpbox">${pzCmpHtml(e, side, other)}</div>` : ''}
  <div class="rs_pz_card_foot">
    ${side === 'src' && !same ? '<span class="rs_pz_card_note">这里改的只影响插入的内容</span>' : ''}
    ${same ? `<span class="rs_pz_card_same">和${side === 'tgt' ? '来源' : '目标'}相比无更改</span>` : ''}
    <div class="rs_bar_spacer"></div>
    ${differs && side === 'tgt' ? '<span class="rs_pz_card_btn" data-a="take">全部用来源的</span>' : ''}
    ${side === 'tgt' && !e.marker ? '<span class="rs_pz_card_btn rs_pz_card_del" data-a="del">删除</span>' : ''}
  </div>
</div>`;
}

function pzItemHtml(v, side, maps) {
    const e = v.e;
    const other = maps ? pzFind(e, maps) : null;
    const open = pz.open.has(side + e.key);
    return `<div class="rs_pz_item${open ? ' rs_pz_open' : ''}" data-k="${escapeHtml(e.key)}">${pzRowHtml(e, side, other, v)}${open ? pzCardHtml(e, side, other) : ''}</div>`;
}

function pzFitCards() {
    $('#rs_panel .rs_pz_ct').each(function () { pzFit(this); });
}

function pzFit(el) {
    const list = el.closest('.rs_pz_list');
    const max = Math.max(PZ_CARD_MIN, (list?.clientHeight || window.innerHeight / 2) - 110);
    el.style.height = 'auto';
    el.style.height = Math.max(PZ_CARD_MIN, Math.min(el.scrollHeight + 2, max)) + 'px';
}

function pzRenderList(side) {
    const src = pz.src?.entries || [];
    const list = side === 'src' ? src : pz.tl;
    const maps = side === 'src' ? pzMaps(pz.tl) : pz.src ? pzMaps(src) : null;
    const rows = pzVisible(list, side, side);
    const empty = side === 'src'
        ? (src.length ? '没有符合的条目' : '这里没有条目。可以点右上角的文件图标导入 txt、Word 或 json。')
        : (pz.tl.length ? '没有符合的条目' : '这个预设还没有条目');
    $(`#rs_panel .rs_pz_${side}_list`).html(rows.length ? rows.map(v => pzItemHtml(v, side, maps)).join('') : `<div class="rs_empty">${empty}</div>`);
    const heads = list.filter(e => e.div);
    $(`#rs_panel .rs_pz_foldall[data-side="${side}"]`).toggle(heads.length > 0);
    if (!heads.some(e => e.key === pz.catf[side])) pz.catf[side] = '';
    $(`#rs_panel .rs_pz_cats[data-side="${side}"]`).toggleClass('rs_on', heads.length > 0).html(heads.length
        ? `<span class="rs_chip${pz.catf[side] ? '' : ' rs_on'}" data-c="">全部</span>` + heads.map(e => `<span class="rs_chip${pz.catf[side] === e.key ? ' rs_on' : ''}" data-c="${escapeHtml(e.key)}">${escapeHtml(e.cat)}</span>`).join('')
        : '');
}

function pzPosLabel() {
    if (pz.pos === 'start') return '插到最前';
    const e = pz.pos !== 'end' && pz.tl.find(x => x.id === pz.pos && x.inOrder);
    if (!e) pz.pos = 'end';
    return e ? `插在「${e.name || '（无名）'}」后` : '插到最后';
}

function pzRender() {
    pz.editing = null;
    pz.tl = pzTgtEntries();
    pzRenderList('src');
    pzRenderList('tgt');
    pzFitCards();
    pzButtons();
    $('#rs_panel .rs_pz_pos').text(pzPosLabel());
    $('#rs_panel .rs_pz_schbtn').toggle(!pzIsWorld());
    pzTokUi();
    if (pz.tokOn) pzRefreshTok();
    if (pz.sch) pzRenderSch();
    if (pz.picking) pzRenderPick();
    pzRenderAct();
}

function pzRenderPick() {
    const list = pz.tl.filter(e => e.inOrder);
    const rows = pzVisible(list, 'pick', 'pick');
    const row = v => {
        const e = v.e;
        const fold = e.div && !v.flat ? `<span class="rs_pz_fold fa-solid ${v.open ? 'fa-chevron-down' : 'fa-chevron-right'}"></span>` : '';
        const cat = v.flat && e.cat && !e.div ? `<span class="rs_pz_cat_tag">${escapeHtml(e.cat)}</span>` : '';
        const count = e.div && !v.flat ? `<span class="rs_pz_cnt">${v.n}</span>` : '';
        return `<div class="rs_pz_item" data-k="${escapeHtml(e.key)}"><div class="rs_pz_row${e.div ? ' rs_pz_div' : ''}${pz.pos === e.id ? ' rs_pz_sel' : ''}">${fold}<div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(e.name || '（无名）')}</span>${count}${cat}</div></div><span class="rs_pz_here rs_pz_pickit">插在这后</span></div></div>`;
    };
    $('#rs_panel .rs_pz_pick_list').html(
        `<div class="rs_pz_item" data-k="@start"><div class="rs_pz_row${pz.pos === 'start' ? ' rs_pz_sel' : ''}"><div class="rs_pz_main"><div class="rs_pz_name">插到最前</div></div><span class="rs_pz_here rs_pz_pickit">选这里</span></div></div>`
        + `<div class="rs_pz_item" data-k="@end"><div class="rs_pz_row${pz.pos === 'end' ? ' rs_pz_sel' : ''}"><div class="rs_pz_main"><div class="rs_pz_name">插到最后</div></div><span class="rs_pz_here rs_pz_pickit">选这里</span></div></div>`
        + rows.map(row).join(''));
}

function pzOpenPick(on) {
    pz.picking = on;
    $('#rs_panel .rs_pz').toggleClass('rs_pz_picking_pos', on);
    if (!on) return;
    $('#rs_panel .rs_pz_q[data-side="pick"]').val('');
    pzRenderPick();
}

function pzPickTap(item, onFold) {
    const k = item.dataset.k;
    if (k === '@start' || k === '@end') pz.pos = k.slice(1);
    else {
        const e = pz.tl.find(x => x.key === k);
        if (!e) return;
        if (e.div && onFold && !pzQuery('pick')) {
            pzToggleFold('pick', k);
            return pzRenderPick();
        }
        pz.pos = e.id;
    }
    pzOpenPick(false);
    $('#rs_panel .rs_pz_pos').text(pzPosLabel());
}

function pzToggleFold(side, key) {
    const k = side + key;
    flip(pz.unfold, k);
}

function pzFoldAll(side) {
    const list = side === 'src' ? pz.src?.entries || [] : pz.tl;
    const heads = list.filter(e => e.div).map(e => side + e.key);
    const anyOpen = heads.some(k => pz.unfold.has(k));
    heads.forEach(k => anyOpen ? pz.unfold.delete(k) : pz.unfold.add(k));
    pzRenderList(side);
    pzFitCards();
}

function pzSideOf(el) {
    return el.closest('.rs_pz_src_list') ? 'src' : 'tgt';
}

function pzEntryOf(side, key) {
    return side === 'src' ? pz.src?.entries.find(x => x.key === key) : pz.tl.find(x => x.key === key);
}

function pzTapItem(item, target) {
    const side = pzSideOf(item);
    const key = item.dataset.k;
    const $t = $(target);
    if ($t.closest('.rs_pz_card').length) return;
    if ($t.closest('.rs_drag').length) return;
    if (side === 'src' && $t.closest('.rs_cb_hit').length) {
        pzToggleSel(key);
        return pzRenderAct();
    }
    if (side === 'tgt' && $t.closest('.rs_pz_toggle').length) return pzToggleEnabled(key);
    if (side === 'tgt' && $t.closest('.rs_pz_radio').length) return pzToggleRadio(pzEntryOf(side, key)?.cat);
    if (side === 'tgt' && $t.closest('.rs_pz_here').length) return pzInsert(pz.tl.find(x => x.key === key)?.id);
    const e = pzEntryOf(side, key);
    if (!e) return;
    if (e.div && !pzQuery(side) && !$t.closest('.rs_pz_divedit').length) {
        pzToggleFold(side, key);
        pzRenderList(side);
        return pzFitCards();
    }
    const ok = side + key;
    flip(pz.open, ok);
    pzRefreshItem(side, key);
}

function pzRefreshItem(side, key) {
    const e = pzEntryOf(side, key);
    const $item = $(`#rs_panel .rs_pz_${side}_list > .rs_pz_item[data-k="${CSS.escape(key)}"]`);
    if (!e || !$item.length) return;
    const src = pz.src?.entries || [];
    const maps = side === 'src' ? pzMaps(pz.tl) : pz.src ? pzMaps(src) : null;
    const v = { e };
    if (e.div && !pzQuery(side)) {
        const list = side === 'src' ? src : pz.tl;
        Object.assign(v, { n: pzGroupSize(list, list.indexOf(e)), open: pz.unfold.has(side + key) });
    } else if (pzQuery(side)) v.flat = true;
    const $new = $(pzItemHtml(v, side, maps));
    $item.replaceWith($new);
    $new.find('.rs_pz_ct').each(function () { pzFit(this); });
}

function pzSetField(side, e, f, v, session) {
    if (side === 'src') {
        e[f] = v;
        return;
    }
    const p = pzPrompt(e.id);
    if (!p) return;
    if (!session || pz.editing !== e.key) {
        pzPush();
        pz.editing = session ? e.key : null;
    }
    p[pzIsWorld() && f === 'name' ? 'comment' : f] = v;
    e[f] = v;
    pz.tgt.dirty = true;
    pzButtons();
}
const PZ_CMP_DELAY = 350;

function pzCardInput(el) {
    const item = el.closest('.rs_pz_item');
    const side = pzSideOf(item);
    const f = el.dataset.f;
    if (f === 'content') pzFit(el);
    const e = pzEntryOf(side, item.dataset.k);
    if (!e || (f === 'content' && e.marker)) return;
    pzSetField(side, e, f, el.value, true);
    if (f !== 'content') return;
    clearTimeout(pz.cmpTimer);
    pz.cmpTimer = setTimeout(() => pzRefreshCmp(item, side, e), PZ_CMP_DELAY);
}

function pzRefreshCmp(item, side, e) {
    if (!item.isConnected) return;
    const other = side === 'src' ? pzFind(e, pzMaps(pz.tl)) : pz.src ? pzFind(e, pzMaps(pz.src.entries)) : null;
    const $card = $(item).children('.rs_pz_card');
    const $box = $card.children('.rs_pz_cmpbox');
    const differs = other && pzNorm(other.content) !== pzNorm(e.content);
    const same = other && !differs;
    if (differs) {
        if ($box.length) $box.html(pzCmpHtml(e, side, other));
        else $card.children('.rs_pz_ct').after(`<div class="rs_pz_cmpbox">${pzCmpHtml(e, side, other)}</div>`);
    } else $box.remove();
    const $foot = $card.children('.rs_pz_card_foot');
    $foot.children('.rs_pz_card_same').remove();
    $foot.children('.rs_pz_card_note').toggle(!same);
    if (same) $foot.prepend(`<span class="rs_pz_card_same">和${side === 'tgt' ? '来源' : '目标'}相比无更改</span>`);
    $foot.children('[data-a="take"]').remove();
    if (differs && side === 'tgt') $foot.children('[data-a="del"]').before('<span class="rs_pz_card_btn" data-a="take">全部用来源的</span>');
}

function pzCardDone(el) {
    const item = el.closest('.rs_pz_item');
    if (!item) return;
    pz.editing = null;
    const side = pzSideOf(item);
    const e = pzEntryOf(side, item.dataset.k);
    if (!e) return;
    const $row = $(item).children('.rs_pz_row');
    $row.find('.rs_pz_nm').text(e.name || '（无名）');
    pzRenderAct();
}

async function pzCardAct(btn) {
    const item = btn.closest('.rs_pz_item');
    const side = pzSideOf(item);
    const key = item.dataset.k;
    const e = pzEntryOf(side, key);
    if (!e) return;
    const a = btn.dataset.a;
    if (a === 'take') {
        const o = pz.src && pzFind(e, pzMaps(pz.src.entries));
        if (o) pzSetField(side, e, 'content', o.content);
        return pzRefreshItem(side, key);
    }
    if (a === 'del') {
        if (!(await askConfirm(`从「${pz.tgt.name}」里删掉「${e.name}」？保存前可以撤回`))) return;
        pzPush();
        if (pzIsWorld()) delete pz.tgt.data.entries[e.id];
        else {
            pz.tgt.data.prompts = pz.tgt.data.prompts.filter(x => x.identifier !== e.id);
            pz.tgt.data.prompt_order.forEach(o => { if (Array.isArray(o.order)) o.order = o.order.filter(x => x.identifier !== e.id); });
        }
        pz.open.delete(side + key);
        pzChanged();
    }
}

function pzTakeHunk(btn) {
    const item = btn.closest('.rs_pz_item');
    const side = pzSideOf(item);
    const key = item.dataset.k;
    const d = pz.hunks[side + key];
    const x = d?.hunks[Number(btn.dataset.h)];
    const e = pzEntryOf(side, key);
    if (!x || !e) return;
    const { A, B } = d;
    const next = side === 'tgt'
        ? [...A.slice(0, x.a0), ...B.slice(x.b0, x.b1), ...A.slice(x.a1)]
        : [...B.slice(0, x.b0), ...A.slice(x.a0, x.a1), ...B.slice(x.b1)];
    pzSetField(side, e, 'content', next.join('\n'));
    pzRefreshItem(side, key);
}

function pzRenderAct() {
    const maps = pzMaps(pz.tl);
    const picks = (pz.src?.entries || []).filter(e => pz.sel.has(e.key));
    let add = 0;
    let rep = 0;
    picks.forEach(e => {
        const o = pzFind(e, maps);
        if (!o) add++;
        else if (!pzSame(o, e)) rep++;
    });
    $('#rs_panel .rs_pz_count').text(picks.length ? `已选 ${picks.length}` : '未选择');
    $('#rs_panel .rs_pz_tgt_list').toggleClass('rs_pz_picking', add + rep > 0);
    $('#rs_panel .rs_pz_pos').toggleClass('rs_off', !(add + rep));
    $('#rs_panel .rs_pz_insert')
        .text(add || rep ? [add && `插入 ${add}`, rep && `替换 ${rep}`].filter(Boolean).join(' · ') : '插入')
        .toggleClass('rs_off', !(add || rep));
}

function pzToggleSel(key, on) {
    if (on ?? !pz.sel.has(key)) pz.sel.add(key);
    else pz.sel.delete(key);
    const sel = pz.sel.has(key);
    $(`#rs_panel .rs_pz_src_list > .rs_pz_item[data-k="${CSS.escape(key)}"] > .rs_pz_row`).toggleClass('rs_pz_sel', sel);
}

function pzSelectAll() {
    const list = pz.src?.entries || [];
    const ci = !pzQuery('src') && pz.catf.src ? list.findIndex(e => e.key === pz.catf.src) : -1;
    const rows = ci >= 0 ? list.slice(ci, ci + 1 + pzGroupSize(list, ci)) : pzFilter(list, 'src');
    const all = rows.length && rows.every(e => pz.sel.has(e.key));
    rows.forEach(e => pzToggleSel(e.key, !all));
    pzRenderAct();
}

const pzSnap = t => structuredClone(t.type === 'w' ? { entries: t.data.entries } : { prompts: t.data.prompts, prompt_order: t.data.prompt_order });

function pzPush() {
    const t = pz.tgt;
    t.undo.push(pzSnap(t));
    if (t.undo.length > PZ_UNDO) t.undo.shift();
    t.redo = [];
}

function pzChanged() {
    pz.tgt.dirty = true;
    pzRender();
}

function pzStep(back) {
    const t = pz.tgt;
    const s = t && (back ? t.undo : t.redo).pop();
    if (!s) return;
    (back ? t.redo : t.undo).push(pzSnap(t));
    Object.assign(t.data, s);
    pzChanged();
}

function pzButtons() {
    const t = pz.tgt;
    $('#rs_panel .rs_pz_undo').toggleClass('rs_off', !t?.undo.length);
    $('#rs_panel .rs_pz_redo').toggleClass('rs_off', !t?.redo.length);
    $('#rs_panel .rs_pz_save').toggleClass('rs_off', !t?.dirty).text(t?.dirty ? '保存' : '已保存');
}

const pzSrcOn = e => !pz.src?.v.startsWith('f:') && !!e.enabled;

let pzWiApi;

async function pzWorldApi() {
    if (pzWiApi === undefined) {
        try { pzWiApi = await import('/scripts/world-info.js'); } catch { pzWiApi = null; }
    }
    return pzWiApi;
}

async function pzNewWorldEntry(data) {
    await pzWorldApi();
    const made = pzWiApi?.createWorldInfoEntry?.(null, data);
    if (made) return made;
    const uids = Object.keys(data.entries).map(Number).filter(Number.isInteger);
    const uid = uids.length ? Math.max(...uids) + 1 : 0;
    return (data.entries[uid] = { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, selective: true, order: 100, position: 0, disable: false, probability: 100, useProbability: true, depth: 4 });
}

async function pzInsert(here) {
    const t = pz.tgt;
    const picks = (pz.src?.entries || []).filter(e => pz.sel.has(e.key));
    if (!t || !picks.length) return;
    pzPush();
    const world = pzIsWorld();
    const maps = pzMaps(pz.tl);
    const pos = here || pz.pos || 'end';
    const ids = world ? pz.tl.map(x => x.id) : pzOrder(t.data).order.map(o => o.identifier);
    const idx = ids.indexOf(pos);
    let at = pos === 'start' ? 0 : idx >= 0 ? idx + 1 : ids.length;
    let add = 0;
    let rep = 0;
    for (const e of picks) {
        const o = pzFind(e, maps);
        if (o) {
            const p = pzPrompt(o.id);
            if (p && !pzSame(o, e)) {
                if (world) Object.assign(p, { comment: e.name, content: e.content });
                else Object.assign(p, { name: e.name, role: e.role || p.role, content: e.content });
                rep++;
            }
            continue;
        }
        let id;
        if (world) {
            const w = await pzNewWorldEntry(t.data);
            const base = e.wraw ? structuredClone(e.wraw) : { constant: true };
            delete base.uid;
            Object.assign(w, base, { comment: e.name, content: e.content, disable: !pzSrcOn(e) });
            id = String(w.uid);
        } else {
            const prompts = t.data.prompts;
            const base = e.raw ? structuredClone(e.raw) : {};
            id = base.identifier && !prompts.some(x => x.identifier === base.identifier) ? base.identifier : pzUid();
            prompts.push({
                system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, forbid_overrides: false,
                ...base, identifier: id, name: e.name, role: e.role || base.role || 'system', content: e.content,
            });
            pzOrder(t.data).order.splice(at, 0, { identifier: id, enabled: pzSrcOn(e) });
        }
        ids.splice(at++, 0, id);
        const ne = { ...e, id, key: (world ? 'w:' : 'p:') + id };
        maps.byId.set(id, ne);
        if (!maps.byName.has(ne.name.trim())) maps.byName.set(ne.name.trim(), ne);
        add++;
    }
    if (world) pzReorderWorld(ids);
    if (!add && !rep) {
        t.undo.pop();
        toastr.info('选中的条目目标里都有，内容也一样');
        return;
    }
    pz.sel.clear();
    pzChanged();
    toastr.success([add && `插入 ${add} 条`, rep && `替换 ${rep} 条`].filter(Boolean).join('，') + '，记得点保存');
}
function pzMove(key, toKey, after) {
    const a = pz.tl.find(x => x.key === key);
    const b = pz.tl.find(x => x.key === toKey);
    if (!a || !b) return;
    if (pzIsWorld()) {
        const ids = pz.tl.map(x => x.id);
        const i = ids.indexOf(a.id);
        const next = ids.filter(x => x !== a.id);
        next.splice(next.indexOf(b.id) + (after ? 1 : 0), 0, a.id);
        if (next[i] === a.id) return;
        pzPush();
        pzReorderWorld(next);
        return pzChanged();
    }
    const order = pzOrder(pz.tgt.data).order;
    const next = [...order];
    const i = next.findIndex(o => o.identifier === a.id);
    const item = i >= 0 ? next.splice(i, 1)[0] : { identifier: a.id, enabled: false };
    const j = next.findIndex(o => o.identifier === b.id);
    next.splice(j < 0 ? next.length : j + (after ? 1 : 0), 0, item);
    if (i >= 0 && next[i] === item) return;
    pzPush();
    order.splice(0, order.length, ...next);
    pzChanged();
}
const pzTgtKey = () => `${pz.tgt.type}:${pz.tgt.name}`;
const pzRadioOn = cat => !!cat && !!pz.tgt && (settings().pzRadio?.[pzTgtKey()] || []).includes(cat);

function pzToggleRadio(cat) {
    if (!cat || !pz.tgt) return;
    const all = settings().pzRadio || (settings().pzRadio = {});
    const k = pzTgtKey();
    const list = all[k] || [];
    all[k] = list.includes(cat) ? list.filter(x => x !== cat) : [...list, cat];
    if (!all[k].length) delete all[k];
    ctx().saveSettingsDebounced();
    pzRenderList('tgt');
    pzFitCards();
    toastr.info(pzRadioOn(cat) ? `「${cat}」改成单选了：打开一条，同类的其他条会自动关掉` : `「${cat}」不再单选`);
}

function pzSetEnabled(e, on) {
    if (pzIsWorld()) pz.tgt.data.entries[e.id].disable = !on;
    else {
        const order = pzOrder(pz.tgt.data).order;
        const o = order.find(x => x.identifier === e.id);
        if (o) o.enabled = on;
        else if (on) order.push({ identifier: e.id, enabled: true });
    }
}

function pzToggleEnabled(key) {
    const e = pz.tl.find(x => x.key === key);
    if (!e) return;
    pzPush();
    const on = !e.enabled;
    pzSetEnabled(e, on);
    let off = 0;
    if (on && !e.div && !e.end && pzRadioOn(e.cat)) {
        pz.tl.filter(x => x !== e && x.cat === e.cat && x.enabled && !x.div && !x.end).forEach(x => {
            pzSetEnabled(x, false);
            off++;
        });
    }
    pzChanged();
    if (off) toastr.info(`单选分类：同类关掉了 ${off} 条`);
}

const PZ_TOK_BATCH = 20;

function pzTokOf(e) {
    return e.marker ? null : pz.tokCache.get(e.content);
}

function pzTokTag(e, x) {
    if (e.div && !x.flat) {
        const list = pz.tl;
        const i = list.indexOf(e);
        const n = pzGroupSize(list, i);
        const sum = [e, ...list.slice(i + 1, i + 1 + n)].filter(y => y.enabled).reduce((a, y) => a + (pzTokOf(y) || 0), 0);
        return `<span class="rs_pz_tok">开启的共 ${sum.toLocaleString()}</span>`;
    }
    const n = pzTokOf(e);
    return n == null ? '' : `<span class="rs_pz_tok">${n.toLocaleString()}</span>`;
}

async function pzCountTokens() {
    const c = ctx();
    const count = c.getTokenCountAsync || (t => Promise.resolve(Math.ceil(t.length / 2)));
    const todo = [...new Set(pz.tl.filter(e => !e.marker).map(e => e.content))].filter(t => !pz.tokCache.has(t));
    if (!todo.length) return false;
    for (let i = 0; i < todo.length; i += PZ_TOK_BATCH) {
        const part = todo.slice(i, i + PZ_TOK_BATCH);
        const ns = await Promise.all(part.map(t => count(t).catch(() => 0)));
        part.forEach((t, j) => pz.tokCache.set(t, Number(ns[j]) || 0));
        if (pz.tokOn) $('#rs_panel .rs_pz_tokbar').text(`正在统计 token……${Math.min(i + PZ_TOK_BATCH, todo.length)}/${todo.length}`);
    }
    return true;
}

function pzTokSummary() {
    const on = pz.tl.filter(e => e.enabled && !e.marker);
    const sum = l => l.reduce((a, e) => a + (pzTokOf(e) || 0), 0);
    return `已开启 ${on.length} 条，共 ${sum(on).toLocaleString()} token（全部 ${sum(pz.tl.filter(e => !e.marker)).toLocaleString()}）`;
}

async function pzRefreshTok() {
    if (!pz.tokOn) return;
    if (await pzCountTokens()) {
        pzRenderList('tgt');
        pzFitCards();
    }
    $('#rs_panel .rs_pz_tokbar').text(pzTokSummary());
}

function pzTokUi() {
    $('#rs_panel .rs_pz_tokbtn, #rs_panel .rs_pz_tokbar, #rs_panel .rs_pz_tokopts').toggleClass('rs_on', pz.tokOn);
    $('#rs_panel .rs_pz_toksort').toggleClass('rs_on', pz.tokSort);
    $('#rs_panel .rs_pz_tgt_list').toggleClass('rs_pz_toksorted', pz.tokOn && pz.tokSort);
}

async function pzToggleTok() {
    pz.tokOn = !pz.tokOn;
    pzTokUi();
    $('#rs_panel .rs_pz_tokbar').text('正在统计 token……');
    pzRenderList('tgt');
    pzFitCards();
    await pzRefreshTok();
}

async function presetSave(pm, name, preset) {
    const res = await apiPost('/api/presets/save', { apiId: 'openai', name, preset });
    if (!res?.ok) {
        toastr.error('保存预设失败');
        return false;
    }
    const st = pzStored(pm, name);
    if (st) pm.getPresetList().presets[st.idx] = preset;
    return true;
}

async function pzWrite(pm, name, preset) {
    if (!(await presetSave(pm, name, preset))) return false;
    if (name === pm.getSelectedPresetName()) {
        const live = await pzLive(pm);
        if (live) {
            live.prompts = structuredClone(preset.prompts);
            live.prompt_order = structuredClone(preset.prompt_order);
            ctx().saveSettingsDebounced();
            try { (await import('/scripts/openai.js')).promptManager?.render?.(false); } catch { }
        }
    }
    return true;
}

async function pzWriteWorld(name, data) {
    const c = ctx();
    try {
        await c.saveWorldInfo(name, data, true);
        c.reloadWorldInfoEditor?.(name);
        return true;
    } catch (e) {
        console.error('[重生成拼接] 保存世界书失败', e);
        toastr.error('保存世界书失败');
        return false;
    }
}

function pzRemoved(t, before) {
    if (t.type === 'w') {
        const list = pzWorldList(before);
        return list.filter(w => !t.data.entries[w.uid]).map(w => ({
            type: 'wi', label: wiName(w), sub: `世界书「${t.name}」`,
            data: { name: t.name, item: w, after: list[list.indexOf(w) - 1]?.uid ?? null },
        }));
    }
    const ids = new Set(t.data.prompts.map(x => x.identifier));
    const order = pzOrder(before).order;
    return (before.prompts || []).filter(x => !ids.has(x.identifier)).map(x => {
        const i = order.findIndex(o => o.identifier === x.identifier);
        return {
            type: 'pz', label: String(x.name || '（无名）'), sub: `预设「${t.name}」`,
            data: { name: t.name, item: x, enabled: i >= 0 && !!order[i].enabled, after: i > 0 ? order[i - 1].identifier : null, inOrder: i >= 0 },
        };
    });
}

async function pzSave() {
    const t = pz.tgt;
    if (!t?.dirty) return;
    const world = t.type === 'w';
    const pm = world ? null : await pzPM();
    const before = world ? structuredClone(await ctx().loadWorldInfo(t.name)) : structuredClone(pzStored(pm, t.name)?.preset || null);
    const write = d => (world ? pzWriteWorld(t.name, d) : pzWrite(pm, t.name, d));
    const $btn = $('#rs_panel .rs_pz_save').addClass('rs_off');
    let ok = false;
    try {
        ok = await write(structuredClone(t.data));
    } catch (e) {
        console.error('[重生成拼接] 保存失败', e);
        toastr.error('保存失败');
    }
    $btn.removeClass('rs_off');
    if (!ok) return;
    if (before) await binAdd(pzRemoved(t, before));
    t.dirty = false;
    pzRender();
    toastr.success(`「${t.name}」已保存，点这里撤回`, '', {
        onclick: async () => {
            if (!before || !(await write(before))) return;
            if (state.target?.kind === 'preset' && pz.tgt?.name === t.name && pz.tgt.type === t.type && !pz.tgt.dirty) {
                await pzSetTarget(t.name, t.type);
                pzRender();
            }
            toastr.info('已撤回');
        },
    });
}
const PZ_DIFF_MAX = 600000;
const PZ_CHAR_MAX = 250000;
const PZ_KEEP_CTX = 2;

function pzLcs(A, B) {
    const n = A.length;
    const m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) {
            ops.push([' ', i++, j++]);
        } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', i++, j]);
        else ops.push(['+', i, j++]);
    }
    while (i < n) ops.push(['-', i++, j]);
    while (j < m) ops.push(['+', i, j++]);
    return ops;
}

function pzCharHtml(a, b, side) {
    const A = [...a];
    const B = [...b];
    if (A.length * B.length > PZ_CHAR_MAX) return escapeHtml(side === '-' ? a : b);
    let html = '';
    let run = '';
    let on = false;
    const flush = () => {
        if (run) html += on ? `<mark>${escapeHtml(run)}</mark>` : escapeHtml(run);
        run = '';
    };
    pzLcs(A, B).forEach(([t, i, j]) => {
        if (t !== ' ' && t !== side) return;
        const hit = t === side;
        if (hit !== on) {
            flush();
            on = hit;
        }
        run += side === '-' ? A[i] : B[j];
    });
    flush();
    return html;
}

function pzDiffHtml(a, b, hk) {
    const A = pzNorm(a).split('\n');
    const B = pzNorm(b).split('\n');
    if (A.length * B.length > PZ_DIFF_MAX) return '<div class="rs_empty">内容太长，没法逐行对比</div>';
    const ops = pzLcs(A, B);
    if (ops.every(o => o[0] === ' ')) return '<div class="rs_empty">内容和对面完全一样</div>';
    const hunks = [];
    const plain = (s, cls = '') => `<div class="rs_pz_dl${cls}">${s || '&nbsp;'}</div>`;
    let html = `<div class="rs_pz_legend"><span class="rs_pz_dl_del">目标</span><span class="rs_pz_dl_add">来源</span><span class="rs_pz_legend_tip">底色深的字是不一样的地方</span></div>`;
    for (let k = 0; k < ops.length;) {
        if (ops[k][0] === ' ') {
            let e = k;
            while (e < ops.length && ops[e][0] === ' ') e++;
            const run = ops.slice(k, e).map(o => plain(escapeHtml(A[o[1]])));
            const head = k === 0 ? 0 : PZ_KEEP_CTX;
            const tail = e === ops.length ? 0 : PZ_KEEP_CTX;
            html += run.length > head + tail + 2
                ? run.slice(0, head).join('') + plain(`…… ${run.length - head - tail} 行相同 ……`, ' rs_pz_dl_skip') + run.slice(run.length - tail).join('')
                : run.join('');
            k = e;
            continue;
        }
        let e = k;
        while (e < ops.length && ops[e][0] !== ' ') e++;
        const dels = ops.slice(k, e).filter(o => o[0] === '-').map(o => o[1]);
        const adds = ops.slice(k, e).filter(o => o[0] === '+').map(o => o[2]);
        const h = hunks.length;
        hunks.push({ a0: dels.length ? dels[0] : ops[k][1], a1: dels.length ? dels[dels.length - 1] + 1 : ops[k][1], b0: adds.length ? adds[0] : ops[k][2], b1: adds.length ? adds[adds.length - 1] + 1 : ops[k][2] });
        html += `<div class="rs_pz_hunk">`;
        dels.forEach((i, x) => { html += plain(x < adds.length ? pzCharHtml(A[i], B[adds[x]], '-') : escapeHtml(A[i]), ' rs_pz_dl_del'); });
        adds.forEach((j, x) => { html += plain(x < dels.length ? pzCharHtml(A[dels[x]], B[j], '+') : escapeHtml(B[j]), ' rs_pz_dl_add'); });
        if (hk) html += `<div class="rs_pz_hunk_act" data-h="${h}">${hk.startsWith('tgt') ? '这处用来源的' : '这处用目标的'}</div>`;
        html += '</div>';
        k = e;
    }
    if (hk) pz.hunks[hk] = { hunks, A, B };
    return html;
}

function pzPrompt(id) {
    return pzIsWorld() ? pz.tgt.data.entries[id] : pz.tgt.data.prompts.find(p => p.identifier === id);
}
function pzSchemes() {
    const all = settings().pzSchemes || (settings().pzSchemes = {});
    return all[pz.tgt.name] || (all[pz.tgt.name] = []);
}

function pzOnIds() {
    return pzOrder(pz.tgt.data).order.filter(o => o.enabled).map(o => o.identifier);
}

function pzOpenSch(on) {
    pz.sch = on && !!pz.tgt && !pzIsWorld();
    $('#rs_panel .rs_pz').toggleClass('rs_pz_sching', pz.sch);
    if (pz.sch) pzRenderSch();
}

function pzRenderSch() {
    const list = pzSchemes();
    const cur = pzOnIds().sort().join('\n');
    $('#rs_panel .rs_pz_sch_title').text(`开关方案 · ${pz.tgt.name}`);
    $('#rs_panel .rs_pz_sch_list').html(list.length ? list.map((x, i) => {
        const now = [...x.on].sort().join('\n') === cur;
        return `<div class="rs_pz_row rs_pz_sch_row${now ? ' rs_pz_sel' : ''}" data-i="${i}"><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(x.name)}</span>${now ? '<span class="rs_pz_tag rs_pz_same">正在用</span>' : ''}</div><div class="rs_pz_pv">开 ${x.on.length} 条</div></div><span class="rs_pz_card_btn" data-a="upd">更新</span><span class="rs_pz_card_btn" data-a="ren">改名</span><span class="rs_pz_card_btn rs_pz_card_del" data-a="del">删除</span></div>`;
    }).join('') : '<div class="rs_empty">还没有方案。先在目标里把条目开关调好，再点上面的按钮存成方案。</div>');
}

async function pzSchAct(i, a) {
    const list = pzSchemes();
    const x = list[i];
    if (!x) return;
    if (a === 'del') {
        if (!(await askConfirm(`删除方案「${x.name}」？`))) return;
        list.splice(i, 1);
    } else if (a === 'upd') {
        if (!(await askConfirm(`用现在的开关状态覆盖方案「${x.name}」？`))) return;
        x.on = pzOnIds();
    } else if (a === 'ren') {
        const name = await pzAskText('新名字', x.name);
        if (!name) return;
        x.name = name;
    } else return pzApplySch(x);
    ctx().saveSettingsDebounced();
    pzRenderSch();
}

async function pzAskText(title, value = '') {
    const c = ctx();
    if (typeof c.callGenericPopup === 'function') {
        const r = await c.callGenericPopup(title, c.POPUP_TYPE?.INPUT ?? 3, value);
        return typeof r === 'string' ? r.trim() : '';
    }
    return String(prompt(title, value) ?? '').trim();
}

async function pzNewSch() {
    const name = await pzAskText('方案名字', `方案 ${pzSchemes().length + 1}`);
    if (!name) return;
    pzSchemes().push({ name, on: pzOnIds() });
    ctx().saveSettingsDebounced();
    pzRenderSch();
    toastr.success(`存好了「${name}」`);
}

async function pzApplySch(x) {
    const wasDirty = pz.tgt.dirty;
    const set = new Set(x.on);
    pzPush();
    pzOrder(pz.tgt.data).order.forEach(o => { o.enabled = set.has(o.identifier); });
    pzChanged();
    pzOpenSch(false);
    if (wasDirty) return toastr.info(`换成了「${x.name}」，还有别的改动没保存，记得点保存`);
    await pzSave();
}

async function pzChangeTarget(name, type = pz.tgt?.type || 'p') {
    if (pz.tgt?.dirty && !(await askConfirm(`「${pz.tgt.name}」还有改动没保存，切换会丢掉，继续吗？`))) {
        await pzFillSelects();
        return;
    }
    if (!name) {
        const pm = await pzPM();
        name = type === 'w' ? worldNames()[0] : pm?.getSelectedPresetName();
        if (!name) {
            toastr.info(type === 'w' ? '还没有世界书' : '没有预设');
            return pzFillSelects();
        }
    }
    if (await pzSetTarget(name, type)) {
        pz.pos = 'end';
        await pzFillSelects();
        pzRender();
    }
}
function pzReset() {
    pz.tgt = null;
    if (!pz.src?.v.startsWith('f:')) pz.src = null;
    pz.sel.clear();
    pz.open.clear();
    pz.tokOn = false;
    pz.tokSort = false;
    pz.sch = false;
    pz.hunks = {};
    pz.picking = false;
    pz.pos = 'end';
}

async function openStitch() {
    const pm = await pzPM();
    if (!pm) {
        toastr.error('这个版本的酒馆读不到预设');
        return;
    }
    if (!pz.tgt && !(await pzSetTarget(pm.getSelectedPresetName(), 'p'))) return;
    if (!pz.src) await pzSetSource('cur');
    $('#rs_panel .rs_pz').removeClass('rs_pz_picking_pos rs_pz_sching');
    await pzFillSelects();
    pzRender();
    applySplitRatio();
}

const RX_PLACES = [[1, '用户输入'], [2, 'AI 输出'], [3, '快捷命令'], [5, '世界书'], [6, '推理']];
const RX_FLAGS = [['markdownOnly', '只改显示'], ['promptOnly', '只改发送'], ['runOnEdit', '编辑时运行']];
const RX_MACRO = [[0, '不替换宏'], [1, '宏原样替换'], [2, '宏转义后替换']];
const RX_UNDO = 50;

const rx = { scope: 'g', list: [], undo: [], redo: [], dirty: false, ed: null, sel: new Set(), pick: null, unfold: new Set(), last: {} };

function rxBlank() {
    return {
        id: pzUid(), scriptName: '新正则', findRegex: '', replaceString: '', trimStrings: [], placement: [2],
        disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    };
}

async function rxStore(scope = rx.scope) {
    const c = ctx();
    if (scope === 'g') return Array.isArray(c.extensionSettings.regex) ? c.extensionSettings.regex : [];
    if (scope.startsWith('p:')) {
        const pm = await pzPM();
        if (!pm) return [];
        const name = scope.slice(2);
        const live = name === pm.getSelectedPresetName() ? await pzLive(pm) : null;
        return live?.extensions?.regex_scripts || pzStored(pm, name)?.preset?.extensions?.regex_scripts || [];
    }
    const ch = c.characters.find(x => x.avatar === scope.slice(2));
    return ch?.data?.extensions?.regex_scripts || [];
}

async function rxScopes() {
    const pm = await pzPM();
    const curP = pm?.getSelectedPresetName();
    const curC = currentChar()?.avatar;
    return {
        presets: pm ? pzNames(pm).map(n => ({ id: 'p:' + n, name: n })) : [],
        chars: charList().map(x => ({ ...x, id: 'c:' + x.id })),
        curP: curP && 'p:' + curP,
        curC: curC && 'c:' + curC,
    };
}

async function rxOpenPick(mode) {
    rx.pick = { mode, o: await rxScopes() };
    $('#rs_panel .rs_rx_pick_q').val('');
    $('#rs_panel .rs_rx_pick_title').text(mode === 'scope' ? (rx.scope[0] === 'p' ? '选预设' : '选角色') : '移到哪里');
    $('#rs_panel .rs_rx_pick_q').attr('placeholder', mode === 'scope' ? '搜索名字' : '搜索预设或角色');
    $('#rs_panel .rs_rx').addClass('rs_rx_picking');
    rxRenderPick();
}

function rxClosePick() {
    rx.pick = null;
    $('#rs_panel .rs_rx').removeClass('rs_rx_picking');
}

function rxRenderPick() {
    const pk = rx.pick;
    if (!pk) return;
    const q = String($('#rs_panel .rs_rx_pick_q').val() || '').trim().toLowerCase();
    const skip = pk.mode === 'scope' ? null : rx.scope;
    const row = (v, label) => `<div class="rs_pz_item" data-v="${escapeHtml(v)}"><div class="rs_pz_row${v === rx.scope ? ' rs_pz_sel' : ''}"><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(label)}</span></div></div></div></div>`;
    if (pk.mode === 'scope') {
        const t = rx.scope[0];
        const list = (t === 'p' ? pk.o.presets : pk.o.chars).slice();
        const cur = t === 'p' ? pk.o.curP : pk.o.curC;
        list.sort((x, y) => (y.id === cur) - (x.id === cur));
        const labels = nameLabels(list, cur);
        $('#rs_panel .rs_rx_pick_list').html(list.filter(x => !q || labels.get(x.id).toLowerCase().includes(q)).map(x => row(x.id, labels.get(x.id))).join('')
            || '<div class="rs_empty">没有符合的</div>');
        return;
    }
    const group = (g, title, list, curMark) => {
        const items = list.filter(x => x.id !== skip).sort((x, y) => (y.id === curMark) - (x.id === curMark));
        const labels = nameLabels(items, curMark);
        const hits = items.filter(x => !q || labels.get(x.id).toLowerCase().includes(q));
        if (!hits.length) return '';
        const open = q || rx.unfold.has(g);
        return `<div class="rs_pz_item" data-g="${g}"><div class="rs_pz_row rs_pz_div"><span class="rs_pz_fold fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'}"></span><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${title}</span><span class="rs_pz_cnt">${hits.length}</span></div></div></div></div>`
            + (open ? hits : hits.filter(x => x.id === curMark)).map(x => row(x.id, labels.get(x.id))).join('');
    };
    $('#rs_panel .rs_rx_pick_list').html(
        (skip !== 'g' && (!q || '全局正则'.includes(q)) ? row('g', '全局正则') : '')
        + group('p', '预设正则', pk.o.presets, pk.o.curP)
        + group('c', '角色正则', pk.o.chars, pk.o.curC));
}

function rxPickTap(item) {
    const g = item.dataset.g;
    if (g) {
        flip(rx.unfold, g);
        return rxRenderPick();
    }
    const v = item.dataset.v;
    const mode = rx.pick?.mode;
    rxClosePick();
    if (mode === 'scope') rxChangeScope(v);
    else if (mode === 'move') rxMoveTo(v);
    else if (mode === 'bmove') rxMoveSel(v);
}

const rxScopeName = scope => scope === 'g' ? '全局正则' : scope.startsWith('p:') ? `预设「${scope.slice(2)}」` : `角色「${ctx().characters.find(x => x.avatar === scope.slice(2))?.name ?? scope.slice(2)}」`;

async function rxLoad(scope) {
    if (scope !== 'g') await fullChar(ctx().characters.find(x => x.avatar === scope.slice(2)));
    Object.assign(rx, { scope, list: structuredClone(await rxStore(scope)), undo: [], redo: [], dirty: false });
    rx.sel.clear();
}

function rxRegex(str) {
    const m = String(str).match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
    try { return m ? new RegExp(m[1], m[2]) : new RegExp(str); } catch { return null; }
}

function rxRun(script, text) {
    const re = rxRegex(script.findRegex);
    if (!re || !script.findRegex) return null;
    const trim = v => (script.trimStrings || []).reduce((a, t) => t ? a.split(t).join('') : a, String(v ?? ''));
    return text.replace(re, (...args) => {
        const groups = [];
        for (let i = 1; i < args.length && typeof args[i] !== 'number'; i++) groups.push(args[i]);
        return String(script.replaceString ?? '').replace(/\{\{match\}\}|\$&|\$(\d+)/gi, (_, n) => trim(n === undefined ? args[0] : groups[n - 1]));
    });
}

async function rxFillScope() {
    const t = rx.scope === 'g' ? 'g' : rx.scope[0];
    $('#rs_panel .rs_rx_tabs span').each(function () { $(this).toggleClass('rs_on', this.dataset.t === t); });
    $('#rs_panel .rs_rx_namebar').toggleClass('rs_on', t !== 'g');
    if (t === 'g') return;
    const o = await rxScopes();
    const list = t === 'p' ? o.presets : o.chars;
    $('#rs_panel .rs_rx_scope').text(nameLabels(list, t === 'p' ? o.curP : o.curC).get(rx.scope) || rxScopeName(rx.scope));
}

async function rxSetType(t) {
    if (t === 'g') return rxChangeScope('g');
    if (rx.scope.startsWith(t + ':')) return;
    const o = await rxScopes();
    const list = t === 'p' ? o.presets : o.chars;
    const cur = t === 'p' ? o.curP : o.curC;
    const v = [cur, rx.last[t]].find(x => x && list.some(y => y.id === x)) || list[0]?.id;
    if (!v) return toastr.info(t === 'p' ? '没有预设' : '还没有角色卡');
    await rxChangeScope(v);
}

function rxRowHtml(s) {
    const places = RX_PLACES.filter(([v]) => (s.placement || []).includes(v)).map(([, t]) => t);
    const flags = RX_FLAGS.slice(0, 2).filter(([k]) => s[k]).map(([, t]) => t);
    const tags = [...places, ...flags].map(t => `<span class="rs_pz_cat_tag">${escapeHtml(t)}</span>`).join('');
    const bad = s.findRegex && !rxRegex(s.findRegex) ? '<span class="rs_pz_tag rs_pz_diff">表达式有误</span>' : '';
    const sel = rx.sel.has(s.id);
    return `<div class="rs_pz_row${s.disabled ? ' rs_pz_off' : ''}${sel ? ' rs_pz_sel' : ''}" data-k="${escapeHtml(s.id)}"><span class="rs_cb_hit"><span class="rs_cb"></span></span><span class="rs_drag fa-solid fa-grip-lines" title="按住拖动排序"></span><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(s.scriptName || '（无名）')}</span>${bad}${tags}</div><div class="rs_pz_pv rs_rx_pv">${escapeHtml(s.findRegex || '（没写表达式）')}</div></div><span class="rs_icon rs_rx_toggle fa-solid ${s.disabled ? 'fa-toggle-off' : 'fa-toggle-on'}" title="启用或关闭"></span></div>`;
}

function rxRows() {
    const q = String($('#rs_panel .rs_rx_q').val() || '').trim().toLowerCase();
    return rx.list.filter(s => !q || String(s.scriptName).toLowerCase().includes(q) || String(s.findRegex).toLowerCase().includes(q));
}

function rxRenderAct() {
    const ids = new Set(rx.list.map(x => x.id));
    rx.sel.forEach(id => { if (!ids.has(id)) rx.sel.delete(id); });
    const n = rx.sel.size;
    $('#rs_panel .rs_rx_act').toggleClass('rs_on', n > 0);
    $('#rs_panel .rs_rx_count').text(`已选 ${n}`);
}

function rxToggleSel(id) {
    flip(rx.sel, id);
    $(`#rs_panel .rs_rx_list .rs_pz_row[data-k="${CSS.escape(id)}"]`).toggleClass('rs_pz_sel', rx.sel.has(id));
    rxRenderAct();
}

function rxSelectAll() {
    const rows = rxRows();
    const all = rows.length && rows.every(s => rx.sel.has(s.id));
    rows.forEach(s => (all ? rx.sel.delete(s.id) : rx.sel.add(s.id)));
    rxRender();
}

async function rxDeleteSel() {
    const n = rx.sel.size;
    if (!n || !(await askConfirm(`删掉选中的 ${n} 条正则？保存前可以撤回`))) return;
    rxPush();
    rx.list = rx.list.filter(x => !rx.sel.has(x.id));
    rx.sel.clear();
    rxChanged();
}

function rxRender() {
    const rows = rxRows();
    $('#rs_panel .rs_rx_list').html(rows.length ? rows.map(rxRowHtml).join('')
        : `<div class="rs_empty">${rx.list.length ? '没有符合的正则' : '这里还没有正则，可以点 ＋ 新建，或者点文件图标导入 json'}</div>`);
    $('#rs_panel .rs_rx_undo').toggleClass('rs_off', !rx.undo.length);
    $('#rs_panel .rs_rx_redo').toggleClass('rs_off', !rx.redo.length);
    $('#rs_panel .rs_rx_save').toggleClass('rs_off', !rx.dirty).text(rx.dirty ? '保存' : '已保存');
    rxRenderAct();
}

function rxPush() {
    rx.undo.push(structuredClone(rx.list));
    if (rx.undo.length > RX_UNDO) rx.undo.shift();
    rx.redo = [];
}

function rxChanged() {
    rx.dirty = true;
    rxRender();
}

function rxStep(back) {
    const s = (back ? rx.undo : rx.redo).pop();
    if (!s) return;
    (back ? rx.redo : rx.undo).push(structuredClone(rx.list));
    rx.list = s;
    rxChanged();
}

function rxToggle(id) {
    const s = rx.list.find(x => x.id === id);
    if (!s) return;
    rxPush();
    s.disabled = !s.disabled;
    rxChanged();
}

function rxMove(id, toId, after) {
    const i = rx.list.findIndex(x => x.id === id);
    if (i < 0 || !rx.list.some(x => x.id === toId)) return;
    const next = [...rx.list];
    const [s] = next.splice(i, 1);
    next.splice(next.findIndex(x => x.id === toId) + (after ? 1 : 0), 0, s);
    if (next[i] === s) return;
    rxPush();
    rx.list = next;
    rxChanged();
}

async function rxImport(files) {
    const add = [];
    for (const f of files) {
        try {
            const data = JSON.parse(await f.text());
            const arr = Array.isArray(data) ? data : Array.isArray(data?.regex_scripts) ? data.regex_scripts : [data];
            arr.filter(x => x && typeof x.findRegex === 'string').forEach(x => add.push({ ...rxBlank(), ...structuredClone(x), id: pzUid() }));
        } catch {
            toastr.warning(`「${f.name}」不是正则 json`);
        }
    }
    if (!add.length) return toastr.info('没有读到正则');
    rxPush();
    rx.list.push(...add);
    rxChanged();
    toastr.success(`导入 ${add.length} 条，记得点保存`);
}

async function rxChangeScope(scope) {
    if (scope === rx.scope || (rx.dirty && !(await askConfirm('正则还有改动没保存，切换会丢掉，继续吗？')))) return;
    if (scope !== 'g') rx.last[scope[0]] = scope;
    await rxLoad(scope);
    rxFillScope();
    rxRender();
}

async function rxWrite(scope, list) {
    const c = ctx();
    const merge = cur => {
        const old = new Map(cur.map(x => [x.id, x]));
        return structuredClone(list).map(x => old.has(x.id) ? Object.assign(old.get(x.id), x) : x);
    };
    if (scope === 'g') {
        if (!Array.isArray(c.extensionSettings.regex)) c.extensionSettings.regex = [];
        const arr = c.extensionSettings.regex;
        arr.splice(0, arr.length, ...merge(arr));
        c.saveSettingsDebounced();
        return true;
    }
    if (scope.startsWith('p:')) return rxPresetWrite(scope.slice(2), merge(await rxStore(scope)));
    const avatar = scope.slice(2);
    const chid = c.characters.findIndex(x => x.avatar === avatar);
    if (chid < 0) {
        toastr.error('找不到这个角色');
        return false;
    }
    const ch = await fullChar(c.characters[chid]);
    const next = merge(ch.data?.extensions?.regex_scripts || []);
    if (typeof c.writeExtensionField === 'function') await c.writeExtensionField(chid, 'regex_scripts', next);
    else {
        if (!(await postCharUpdate({ avatar, data: { extensions: { regex_scripts: next } } }))) return false;
        ch.data = ch.data || {};
        ch.data.extensions = { ...(ch.data.extensions || {}), regex_scripts: next };
    }
    const ext = c.extensionSettings;
    if (next.length) {
        if (!Array.isArray(ext.character_allowed_regex)) ext.character_allowed_regex = [];
        if (!ext.character_allowed_regex.includes(avatar)) {
            ext.character_allowed_regex.push(avatar);
            c.saveSettingsDebounced();
        }
    }
    return true;
}

async function rxPresetWrite(name, list) {
    const c = ctx();
    const pm = await pzPM();
    const st = pm && pzStored(pm, name);
    if (!st) {
        toastr.error('找不到这个预设');
        return false;
    }
    const preset = structuredClone(st.preset);
    preset.extensions = { ...(preset.extensions || {}), regex_scripts: list };
    if (!(await presetSave(pm, name, preset))) return false;
    if (name === pm.getSelectedPresetName()) {
        const live = await pzLive(pm);
        if (live) live.extensions = { ...(live.extensions || {}), regex_scripts: list };
    }
    const ext = c.extensionSettings;
    if (list.length) {
        ext.preset_allowed_regex = ext.preset_allowed_regex || {};
        const arr = ext.preset_allowed_regex.openai = ext.preset_allowed_regex.openai || [];
        if (!arr.includes(name)) arr.push(name);
    }
    c.saveSettingsDebounced();
    return true;
}

async function rxMoveMany(items, scope) {
    if (!scope || !items.length) return false;
    const label = items.length === 1 ? `「${items[0].scriptName}」` : `选中的 ${items.length} 条正则`;
    if (!(await askConfirm(`把${label}移到${rxScopeName(scope)}？`))) return false;
    const dest = structuredClone(await rxStore(scope));
    const moved = items.map(x => {
        const c = structuredClone(x);
        if (dest.some(d => d.id === c.id)) c.id = pzUid();
        return c;
    });
    if (!(await rxWrite(scope, [...dest, ...moved]))) return false;
    const ids = new Set(items.map(x => x.id));
    const stored = await rxStore(rx.scope);
    if (stored.some(x => ids.has(x.id))) await rxWrite(rx.scope, structuredClone(stored).filter(x => !ids.has(x.id)));
    rx.list = rx.list.filter(x => !ids.has(x.id));
    ids.forEach(id => rx.sel.delete(id));
    rxRender();
    await rxRefreshChat();
    toastr.success(`已移到${rxScopeName(scope)}`);
    return true;
}

async function rxMoveTo(scope) {
    const ed = rx.ed;
    if (!ed || !scope) return;
    const s = rxEdValues();
    if (!String(s.scriptName).trim()) return toastr.warning('给正则起个名字');
    if (await rxMoveMany([s], scope)) rxCloseEd();
}

async function rxMoveSel(scope) {
    const items = rx.list.filter(x => rx.sel.has(x.id));
    await rxMoveMany(items, scope);
}

async function rxRefreshChat() {
    const c = ctx();
    try { if (c.getCurrentChatId?.()) await c.reloadCurrentChat?.(); } catch { }
}

async function rxSave() {
    if (!rx.dirty) return;
    const scope = rx.scope;
    const before = structuredClone(await rxStore(scope));
    const $btn = $('#rs_panel .rs_rx_save').addClass('rs_off');
    let ok = false;
    try {
        ok = await rxWrite(scope, rx.list);
    } catch (e) {
        console.error('[重生成拼接] 保存正则失败', e);
        toastr.error('保存正则失败');
    }
    $btn.removeClass('rs_off');
    if (!ok) return;
    const kept = new Set(rx.list.map(x => x.id));
    await binAdd(before.map((x, i) => [x, i]).filter(([x]) => !kept.has(x.id)).map(([x, i]) => ({
        type: 'rx', label: String(x.scriptName || '（无名）'), sub: rxScopeName(scope), data: { scope, item: x, index: i },
    })));
    rx.dirty = false;
    rxRender();
    await rxRefreshChat();
    toastr.success('正则已保存，点这里撤回', '', {
        onclick: async () => {
            if (!(await rxWrite(scope, before))) return;
            if (state.target?.kind === 'regex' && rx.scope === scope && !rx.dirty) {
                await rxLoad(scope);
                rxRender();
            }
            await rxRefreshChat();
            toastr.info('已撤回');
        },
    });
}

function rxOpenEd(id) {
    const s = id ? rx.list.find(x => x.id === id) : rxBlank();
    if (!s) return;
    rx.ed = { id: id || null, item: structuredClone(s) };
    const chip = (k, v, t, on) => `<span class="rs_chip${on ? ' rs_on' : ''}" data-${k}="${v}">${t}</span>`;
    const at = id ? rx.list.findIndex(x => x.id === id) : -1;
    $('#rs_panel .rs_rx_ed').html(`
<div class="rs_bar"><div class="rs_bar_title">${id ? '编辑正则' : '新建正则'}${at >= 0 ? `<span class="rs_pz_ed_pos">第 ${at + 1} / ${rx.list.length} 条</span>` : ''}</div><div class="rs_icon rs_rx_ed_act fa-solid fa-xmark" data-a="close" title="关闭"></div></div>
<div class="rs_rx_form">
  <input type="text" class="rs_rx_f rs_pz_ed_name" data-f="scriptName" placeholder="名称">
  <div class="rs_rx_lb">查找</div>
  <textarea class="rs_rx_f rs_rx_code" data-f="findRegex" rows="2" spellcheck="false" placeholder="/表达式/标志，比如 /<think>[\\s\\S]*?<\\/think>/g"></textarea>
  <div class="rs_rx_err"></div>
  <div class="rs_rx_rep">
    <div class="rs_rx_lb rs_rx_lbrow"><span>替换为</span><span class="rs_bar_spacer"></span>
      <span class="rs_icon rs_rx_tool fa-solid fa-rotate-left rs_off" data-t="undo" title="撤销"></span>
      <span class="rs_chip rs_rx_tool" data-t="find"><i class="fa-solid fa-magnifying-glass"></i></span>
      <span class="rs_chip rs_rx_tool" data-t="img">图片<span class="rs_rx_n"></span></span>
      <span class="rs_chip rs_rx_tool" data-t="color">颜色<span class="rs_rx_n"></span></span>
      <span class="rs_icon rs_rx_tool fa-solid fa-expand" data-t="full" title="放大"></span>
    </div>
    <div class="rs_rx_tbox"></div>
    <div class="rs_rx_repwrap"><div class="rs_rx_hl rs_rx_code"></div><textarea class="rs_rx_f rs_rx_code rs_rx_reptext" data-f="replaceString" rows="3" spellcheck="false" placeholder="留空就是删掉；{{match}} 或 $1 引用匹配内容"></textarea></div>
  </div>
  <div class="rs_rx_lb">修剪掉</div>
  <textarea class="rs_rx_f rs_rx_code" data-f="trimStrings" rows="2" spellcheck="false" placeholder="一行一个，替换前从匹配内容里去掉"></textarea>
  <div class="rs_rx_lb">作用于</div>
  <div class="rs_chips">${RX_PLACES.map(([v, t]) => chip('p', v, t, (s.placement || []).includes(v))).join('')}</div>
  <div class="rs_rx_lb">选项</div>
  <div class="rs_chips">${RX_FLAGS.map(([k, t]) => chip('o', k, t, !!s[k])).join('')}</div>
  <div class="rs_rx_line">
    <select class="rs_rx_f text_pole" data-f="substituteRegex">${RX_MACRO.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
    <span>深度</span><input type="number" class="rs_rx_f" data-f="minDepth" placeholder="最小" min="-1"><span>~</span><input type="number" class="rs_rx_f" data-f="maxDepth" placeholder="最大" min="0">
  </div>
  <div class="rs_rx_lb">试一试</div>
  <textarea class="rs_rx_test" rows="3" spellcheck="false" placeholder="贴一段文字看看替换效果"></textarea>
  <div class="rs_rx_out"></div>
</div>
<div class="rs_pz_ed_foot">
  ${id ? '<div class="rs_icon rs_rx_ed_act fa-solid fa-trash-can" data-a="del" title="删除"></div><div class="rs_icon rs_rx_ed_act fa-solid fa-clone" data-a="dup" title="复制一份"></div>' : ''}
  <span class="rs_pz_card_btn rs_rx_move">移到…</span>
  <div class="rs_bar_spacer"></div>
  <div class="menu_button rs_rx_ed_act rs_pz_ed_ok" data-a="ok">${id ? '确定' : '添加'}</div>
</div>`);
    $('#rs_panel .rs_rx_f').each(function () {
        const f = this.dataset.f;
        const v = s[f];
        this.value = f === 'trimStrings' ? (v || []).join('\n') : f === 'substituteRegex' ? String(Number(v) || 0) : v ?? '';
    });
    $('#rs_panel .rs_rx').addClass('rs_rx_editing');
    Object.assign(rt, { tool: null, full: false, undo: [], fi: 0, imgs: [], cols: [] });
    $('#rs_panel .rs_rx_ed').removeClass('rs_rx_full');
    rxTest();
    rtRefresh();
}

const rt = { tool: null, full: false, undo: [], fi: 0, imgs: [], cols: [] };
const RT_IMG = /https?:\/\/[^\s"'`<>()\\]+/g;
const RT_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\([^()]*\)/g;
const rtTa = () => $('#rs_panel .rs_rx_reptext')[0];

function rtImgHits(text) {
    const out = [];
    for (const m of text.matchAll(RT_IMG)) {
        const u = m[0].replace(/[.,;:!?]+$/, '');
        const before = text.slice(Math.max(0, m.index - 12), m.index);
        if (/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(?:[?#]|$)/i.test(u) || /(?:url\(\s*["']?|src\s*=\s*["']?)$/i.test(before)) out.push({ s: u, i: m.index });
    }
    return out;
}

const rtColorHits = text => [...text.matchAll(RT_COLOR)].map(m => ({ s: m[0], i: m.index }));

function rtGroup(hits) {
    const map = new Map();
    hits.forEach((h, n) => {
        if (!map.has(h.s)) map.set(h.s, []);
        map.get(h.s).push(n);
    });
    return [...map].map(([s, ords]) => ({ s, ords }));
}

function rtSwap(text, hits, ords, to) {
    const set = new Set(ords);
    let out = '';
    let last = 0;
    hits.forEach((h, n) => {
        if (!set.has(n)) return;
        out += text.slice(last, h.i) + to;
        last = h.i + h.s.length;
    });
    return out + text.slice(last);
}

function rtSet(v, noUndo) {
    const ta = rtTa();
    if (!ta || ta.value === v) return;
    if (!noUndo) rt.undo.push(ta.value);
    if (rt.undo.length > 50) rt.undo.shift();
    ta.value = v;
    rxTest();
    rtRefresh();
}

let rtCanvas = null;

function rtParse(str) {
    rtCanvas = rtCanvas || document.createElement('canvas').getContext('2d');
    const probe = seed => {
        rtCanvas.fillStyle = seed;
        rtCanvas.fillStyle = str;
        return String(rtCanvas.fillStyle);
    };
    const n = probe('#000000');
    if (n !== probe('#ffffff')) return null;
    if (n.startsWith('#')) return { r: parseInt(n.slice(1, 3), 16), g: parseInt(n.slice(3, 5), 16), b: parseInt(n.slice(5, 7), 16), a: 1 };
    const v = n.match(/[\d.]+/g)?.map(Number) || [];
    return { r: v[0] || 0, g: v[1] || 0, b: v[2] || 0, a: v[3] ?? 1 };
}

const rtHex = n => Math.round(n).toString(16).padStart(2, '0');

function rtFormat(kind, c) {
    if (kind === 'hex') return `#${rtHex(c.r)}${rtHex(c.g)}${rtHex(c.b)}${c.a < 1 ? rtHex(c.a * 255) : ''}`;
    return c.a < 1 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${+c.a.toFixed(2)})` : `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function rtRefresh() {
    const ta = rtTa();
    if (!ta) return;
    const text = ta.value;
    rt.imgs = rtGroup(rtImgHits(text));
    rt.cols = rtGroup(rtColorHits(text)).map(x => ({ ...x, c: rtParse(x.s) })).filter(x => x.c);
    const $row = $('#rs_panel .rs_rx_lbrow');
    $row.find('[data-t="img"] .rs_rx_n').text(rt.imgs.length ? ` ${rt.imgs.length}` : '');
    $row.find('[data-t="color"] .rs_rx_n').text(rt.cols.length ? ` ${rt.cols.length}` : '');
    $row.find('[data-t="undo"]').toggleClass('rs_off', !rt.undo.length);
    $row.find('[data-t="full"]').toggleClass('fa-expand', !rt.full).toggleClass('fa-compress', rt.full);
    $row.find('.rs_chip').each(function () { $(this).toggleClass('rs_on', rt.tool === this.dataset.t); });
    if (rt.tool === 'find') rtFindRender(false);
    else $('#rs_panel .rs_rx_hl').empty().hide();
}

function rtToolHtml() {
    if (rt.tool === 'find') return `<div class="rs_rx_fb"><input type="text" class="rs_rx_fq" placeholder="查找"><span class="rs_rx_fn"></span><span class="rs_icon fa-solid fa-chevron-up rs_rx_fx" data-x="prev"></span><span class="rs_icon fa-solid fa-chevron-down rs_rx_fx" data-x="next"></span></div>
<div class="rs_rx_fb"><input type="text" class="rs_rx_fr" placeholder="替换成"><span class="rs_chip rs_rx_fx" data-x="one">替换</span><span class="rs_chip rs_rx_fx" data-x="all">全部</span></div>`;
    if (rt.tool === 'img') {
        return rt.imgs.length ? rt.imgs.map((x, i) => `<div class="rs_rx_irow" data-i="${i}"><img class="rs_rx_ithumb" src="${escapeHtml(x.s)}" loading="lazy" referrerpolicy="no-referrer" alt=""><input type="url" class="rs_rx_iu" value="${escapeHtml(x.s)}"><span class="rs_rx_cnt">${x.ords.length > 1 ? `×${x.ords.length}` : ''}</span><span class="rs_icon fa-solid fa-paste rs_rx_ipaste" title="粘贴新链接"></span></div>`).join('')
            : '<div class="rs_rx_none">没找到图片链接</div>';
    }
    if (rt.tool === 'color') {
        return rt.cols.length ? rt.cols.map((x, i) => `<div class="rs_rx_crow" data-i="${i}"><label class="rs_rx_sw" style="--c:${escapeHtml(rtFormat('rgb', x.c))}"><input type="color" class="rs_rx_cin" value="${rtFormat('hex', { ...x.c, a: 1 })}"></label><code class="rs_rx_cs">${escapeHtml(x.s)}</code><span class="rs_rx_cnt">${x.ords.length > 1 ? `×${x.ords.length}` : ''}</span><input type="range" class="rs_rx_ca" min="0" max="100" value="${Math.round(x.c.a * 100)}" title="透明度"></div>`).join('')
            : '<div class="rs_rx_none">没找到颜色</div>';
    }
    return '';
}

function rtTbox() {
    $('#rs_panel .rs_rx_tbox').html(rtToolHtml()).find('.rs_rx_ithumb').on('error', function () { this.classList.add('rs_bad'); });
}

function rtTool(t) {
    if (t === 'undo') {
        if (!rt.undo.length) return;
        rtSet(rt.undo.pop(), true);
        if (rt.tool !== 'find') rtTbox();
        return;
    }
    if (t === 'full') {
        rt.full = !rt.full;
        $('#rs_panel .rs_rx_ed').toggleClass('rs_rx_full', rt.full);
        return rtRefresh();
    }
    rt.tool = rt.tool === t ? null : t;
    rt.fi = 0;
    rtTbox();
    rtRefresh();
    if (rt.tool === 'find') $('#rs_panel .rs_rx_fq').trigger('focus');
}

function rtFindHits() {
    const q = String($('#rs_panel .rs_rx_fq').val() || '').toLowerCase();
    const text = rtTa()?.value.toLowerCase() || '';
    const out = [];
    if (!q) return out;
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) out.push({ i, n: q.length });
    return out;
}

function rtFindRender(scroll) {
    const ta = rtTa();
    const hl = $('#rs_panel .rs_rx_hl')[0];
    if (!ta || !hl) return;
    const hits = rtFindHits();
    if (rt.fi >= hits.length) rt.fi = Math.max(0, hits.length - 1);
    $('#rs_panel .rs_rx_fn').text(hits.length ? `${rt.fi + 1}/${hits.length}` : String($('#rs_panel .rs_rx_fq').val() || '') ? '0' : '');
    const text = ta.value;
    let html = '';
    let last = 0;
    hits.forEach((h, k) => {
        html += escapeHtml(text.slice(last, h.i)) + `<mark${k === rt.fi ? ' class="rs_cur"' : ''}>${escapeHtml(text.slice(h.i, h.i + h.n))}</mark>`;
        last = h.i + h.n;
    });
    hl.innerHTML = html + escapeHtml(text.slice(last)) + '\n';
    $(hl).toggle(hits.length > 0);
    const cur = hl.querySelector('mark.rs_cur');
    if (scroll && cur) ta.scrollTop = Math.max(0, cur.offsetTop - ta.clientHeight / 3);
    hl.scrollTop = ta.scrollTop;
}

function rtFindAct(x) {
    const hits = rtFindHits();
    if (!hits.length) return;
    if (x === 'prev' || x === 'next') {
        rt.fi = (rt.fi + (x === 'next' ? 1 : -1) + hits.length) % hits.length;
        return rtFindRender(true);
    }
    const to = String($('#rs_panel .rs_rx_fr').val() ?? '');
    const text = rtTa().value;
    const pick = x === 'all' ? hits : [hits[rt.fi]];
    let out = '';
    let last = 0;
    pick.forEach(h => {
        out += text.slice(last, h.i) + to;
        last = h.i + h.n;
    });
    rtSet(out + text.slice(last));
    if (x === 'all') toastr.success(`替换了 ${pick.length} 处，可以撤销`);
    rtFindRender(true);
}

function rtImgSet(row, url) {
    const x = rt.imgs[Number(row.dataset.i)];
    url = String(url || '').trim();
    if (!x || !url || url === x.s) return;
    const text = rtTa().value;
    rtSet(rtSwap(text, rtImgHits(text), x.ords, url));
    rtTbox();
}

async function rtImgPaste(row) {
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch { }
    t = String(t || '').trim();
    if (!/^https?:\/\//i.test(t)) return toastr.warning('剪贴板里不是链接');
    rtImgSet(row, t);
}

function rtColorLive(row) {
    const x = rt.cols[Number(row.dataset.i)];
    if (!x) return;
    const hex = $(row).find('.rs_rx_cin').val();
    const a = Number($(row).find('.rs_rx_ca').val()) / 100;
    const c = { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16), a };
    const to = rtFormat(x.s.startsWith('#') ? 'hex' : 'rgb', c);
    if (to === x.s) return;
    const first = row.dataset.live !== '1';
    row.dataset.live = '1';
    const ta = rtTa();
    const text = ta.value;
    const next = rtSwap(text, rtColorHits(text), x.ords, to);
    if (first) rt.undo.push(text);
    ta.value = next;
    x.s = to;
    x.c = c;
    $(row).find('.rs_rx_cs').text(to);
    $(row).find('.rs_rx_sw').css('--c', rtFormat('rgb', c));
    $('#rs_panel .rs_rx_lbrow [data-t="undo"]').removeClass('rs_off');
    rxTest();
}

function rtColorDone(row) {
    if (row.dataset.live !== '1') return;
    row.dataset.live = '';
    rtRefresh();
    rtTbox();
}

function rxCloseEd() {
    rx.ed = null;
    rt.tool = null;
    rt.full = false;
    $('#rs_panel .rs_rx_ed').removeClass('rs_rx_full');
    $('#rs_panel .rs_rx').removeClass('rs_rx_editing');
    $('#rs_panel .rs_rx_ed').empty();
}

function rxEdValues() {
    const s = rx.ed.item;
    $('#rs_panel .rs_rx_f').each(function () {
        const f = this.dataset.f;
        const v = String(this.value);
        if (f === 'trimStrings') s[f] = v.split('\n').filter(x => x);
        else if (f === 'substituteRegex') s[f] = Number(v) || 0;
        else if (f === 'minDepth' || f === 'maxDepth') s[f] = v === '' ? null : Number(v);
        else s[f] = v;
    });
    s.placement = $('#rs_panel .rs_chip[data-p].rs_on').map(function () { return Number(this.dataset.p); }).get();
    $('#rs_panel .rs_chip[data-o]').each(function () { s[this.dataset.o] = $(this).hasClass('rs_on'); });
    return s;
}

function rxTest() {
    if (!rx.ed) return;
    const s = rxEdValues();
    const bad = s.findRegex && !rxRegex(s.findRegex);
    $('#rs_panel .rs_rx_err').text(bad ? '表达式写得不对' : '').toggle(!!bad);
    const text = String($('#rs_panel .rs_rx_test').val() || '');
    const out = text ? rxRun(s, text) : null;
    $('#rs_panel .rs_rx_out').toggle(!!text).text(out === null ? '' : out === text ? '（没有匹配到）' : out || '（替换后是空的）');
}

async function rxEdAct(a) {
    const ed = rx.ed;
    if (!ed) return;
    if (a === 'close') return rxCloseEd();
    const s = rxEdValues();
    if (a === 'ok') {
        if (!String(s.scriptName).trim()) return toastr.warning('给正则起个名字');
        const i = rx.list.findIndex(x => x.id === ed.id);
        if (i >= 0 && JSON.stringify(rx.list[i]) === JSON.stringify(s)) return rxCloseEd();
        rxPush();
        if (i >= 0) rx.list[i] = structuredClone(s);
        else rx.list.push(structuredClone(s));
        rxCloseEd();
        rxChanged();
    } else if (a === 'dup') {
        const i = rx.list.findIndex(x => x.id === ed.id);
        rxPush();
        rx.list.splice(i + 1, 0, { ...structuredClone(s), id: pzUid(), scriptName: `${s.scriptName} 副本` });
        rxCloseEd();
        rxChanged();
    } else if (a === 'del') {
        if (!(await askConfirm(`删掉正则「${s.scriptName}」？保存前可以撤回`))) return;
        rxPush();
        rx.list = rx.list.filter(x => x.id !== ed.id);
        rxCloseEd();
        rxChanged();
    }
}

function rxReset() {
    rx.ed = null;
    rx.pick = null;
    rx.dirty = false;
    rx.undo = [];
    rx.redo = [];
}

async function openRegex() {
    rxCloseEd();
    rxClosePick();
    const o = await rxScopes();
    const known = rx.scope === 'g' || [...o.presets, ...o.chars].some(x => x.id === rx.scope);
    await rxLoad(known ? rx.scope : 'g');
    rxFillScope();
    rxRender();
}

const DROPS = { pz: pzMove, rx: rxMove };

const bin = { type: '' };

function binAgo(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 60) return `${Math.max(1, m)} 分钟前`;
    if (m < 1440) return `${Math.round(m / 60)} 小时前`;
    return `${Math.round(m / 1440)} 天前`;
}

async function binRender() {
    const all = await binAll();
    const types = [...new Set(all.map(x => x.type))];
    if (bin.type && !types.includes(bin.type)) bin.type = '';
    const list = bin.type ? all.filter(x => x.type === bin.type) : all;
    $('#rs_panel .rs_bin').html(`
<div class="rs_bin_bar">
  <span>${all.length ? `共 ${all.length} 项，保留 ${BIN_DAYS} 天` : ''}</span>
  ${all.length ? '<span class="rs_pz_card_btn rs_pz_card_del rs_bin_clear">清空回收站</span>' : ''}
</div>
${types.length > 1 ? `<div class="rs_pz_cats rs_on">${['', ...types].map(t => `<span class="rs_chip${bin.type === t ? ' rs_on' : ''}" data-t="${t}">${t ? BIN_TYPES[t] : '全部'}</span>`).join('')}</div>` : ''}
<div class="rs_pz_list rs_bin_list">${list.map(x => `<div class="rs_pz_row" data-id="${x.id}"><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(x.label || '（无名）')}</span><span class="rs_pz_cat_tag">${BIN_TYPES[x.type] || x.type}</span></div><div class="rs_pz_pv">${escapeHtml(`${x.sub || ''} · ${binAgo(x.time)}删除`)}</div></div><span class="rs_pz_card_btn" data-a="restore">恢复</span><span class="rs_pz_card_btn rs_pz_card_del" data-a="drop">删除</span></div>`).join('')
    || '<div class="rs_empty">回收站是空的。插件里删掉的聊天文件、预设和世界书条目、正则、楼层版本、存档都会先放在这里。</div>'}</div>`);
}

async function binRestore(x) {
    const d = x.data;
    const c = ctx();
    if (x.type === 'fav') {
        const list = await favAll();
        if (!list.some(y => y.id === d.id)) await idbPut(FAV_KEY, [d, ...list]);
        favMarksSoon();
        return true;
    }
    if (x.type === 'ver') {
        const v = await getVers(d.key);
        if (!v.some(y => y.id === d.item.id)) await putVers(d.key, [...v, d.item]);
        return true;
    }
    if (x.type === 'snap') {
        const a = await getSnaps(d.key);
        const have = new Set(a.map(y => `${y.time}|${y.text}`));
        await idbPut(d.key, [...a, ...d.items.filter(y => !have.has(`${y.time}|${y.text}`))].sort((p, q) => p.time - q.time));
        return true;
    }
    if (x.type === 'swipe') {
        const m = c.chat?.[d.mes];
        if (c.getCurrentChatId?.() !== d.chat || !m) {
            toastr.warning('先打开原来那个聊天再恢复');
            return false;
        }
        m.swipes = Array.isArray(m.swipes) ? m.swipes : [m.mes];
        m.swipes.push(d.text);
        if (Array.isArray(m.swipe_info)) m.swipe_info.push(d.info ?? {});
        refreshSwipeUI(d.mes, m);
        await c.saveChat();
        return true;
    }
    if (x.type === 'rx') {
        if (state.target?.kind === 'regex' && rx.scope === d.scope && rx.dirty) {
            toastr.warning('正则页还有没保存的改动，先保存或撤回');
            return false;
        }
        const cur = structuredClone(await rxStore(d.scope));
        if (!cur.some(y => y.id === d.item.id)) {
            cur.splice(Math.min(d.index, cur.length), 0, d.item);
            if (!(await rxWrite(d.scope, cur))) return false;
        }
        if (state.target?.kind === 'regex' && rx.scope === d.scope) {
            await rxLoad(d.scope);
            rxRender();
        }
        await rxRefreshChat();
        return true;
    }
    if (x.type === 'pz' || x.type === 'wi') {
        const type = x.type === 'wi' ? 'w' : 'p';
        if (pz.tgt?.type === type && pz.tgt.name === d.name && pz.tgt.dirty) {
            toastr.warning('缝合页里这一项还有没保存的改动，先保存或撤回');
            return false;
        }
        if (type === 'w') {
            const data = structuredClone(await c.loadWorldInfo(d.name));
            if (!data?.entries) {
                toastr.warning('找不到这本世界书');
                return false;
            }
            const item = structuredClone(d.item);
            const same = data.entries[item.uid];
            if (!same || same.comment !== item.comment || same.content !== item.content) {
                if (same) item.uid = Math.max(-1, ...Object.keys(data.entries).map(Number).filter(Number.isInteger)) + 1;
                const list = pzWorldList(data);
                const i = d.after == null ? 0 : list.findIndex(w => w.uid === d.after) + 1;
                list.splice(i > 0 ? i : 0, 0, item);
                data.entries[item.uid] = item;
                list.forEach((w, k) => { w.displayIndex = k; });
                if (!(await pzWriteWorld(d.name, data))) return false;
            }
        } else {
            const pm = await pzPM();
            const preset = await pzLoadPreset(d.name);
            if (!preset) {
                toastr.warning('找不到这个预设');
                return false;
            }
            if (!preset.prompts.some(y => y.identifier === d.item.identifier)) {
                preset.prompts.push(structuredClone(d.item));
                if (d.inOrder) {
                    const order = pzOrder(preset).order;
                    const i = d.after ? order.findIndex(o => o.identifier === d.after) + 1 : 0;
                    order.splice(i > 0 ? i : 0, 0, { identifier: d.item.identifier, enabled: d.enabled });
                }
                if (!(await pzWrite(pm, d.name, preset))) return false;
            }
        }
        if (pz.tgt?.type === type && pz.tgt.name === d.name) {
            await pzSetTarget(d.name, type);
            pzRender();
        }
        return true;
    }
    if (x.type === 'card') {
        const form = new FormData();
        form.append('avatar', d.blob, d.avatar);
        form.append('file_type', 'png');
        form.append('preserved_name', d.avatar);
        const res = await formPost('/api/characters/import', form);
        const data = res?.ok ? await res.json().catch(() => null) : null;
        if (!data?.file_name) return false;
        const avatar = `${data.file_name}.png`;
        if (d.tags?.length) c.tagMap[avatar] = [...d.tags];
        c.saveSettingsDebounced();
        await c.getCharacters();
        return true;
    }
    if (x.type === 'persona') {
        const { pu } = await personaInfo();
        if (d.blob) {
            const form = new FormData();
            form.append('avatar', d.blob, d.avatar);
            form.append('overwrite_name', d.avatar);
            if (!(await formPost('/api/avatars/upload', form))?.ok) return false;
        }
        pu.personas[d.avatar] = d.name;
        if (d.desc) (pu.persona_descriptions = pu.persona_descriptions || {})[d.avatar] = d.desc;
        const meta = shelfPersonaMeta();
        if (d.fav && !meta.personaFav.includes(d.avatar)) meta.personaFav.push(d.avatar);
        c.saveSettingsDebounced();
        try { (await import('/scripts/personas.js')).getUserAvatars?.(true); } catch { }
        return true;
    }
    if (x.type === 'book') {
        const id = worldNames().includes(d.name) ? `${d.name} 恢复 ${humanStamp()}` : d.name;
        await c.saveWorldInfo(id, structuredClone(d.data), true);
        await syncLists(true);
        if (!worldNames().includes(id)) return false;
        if (id !== d.name) toastr.info(`原名已被占用，恢复成「${id}」`);
        return true;
    }
    if (x.type === 'chat') {
        const old = await chatGet(d);
        const id = Array.isArray(old) && old.length ? `${d.file_id} 恢复 ${humanStamp()}` : d.file_id;
        if (!(await chatApi('save', { ...d, file_id: id }, d.chat))?.ok) return false;
        const gr = d.group && (c.groups || []).find(y => y.id === d.group);
        if (gr && Array.isArray(gr.chats) && !gr.chats.includes(id)) {
            gr.chats.push(id);
            await apiPost('/api/groups/edit', gr);
        }
        if (id !== d.file_id) toastr.info(`原名已被占用，恢复成「${id}」`);
        return true;
    }
    return false;
}

function humanStamp() {
    const d = new Date();
    const z = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
}

async function binAct(id, a) {
    const x = (await binAll()).find(y => y.id === id);
    if (!x) return;
    if (a === 'drop') {
        if (!(await askConfirm(`彻底删除「${x.label}」？之后就真的找不回来了`))) return;
    } else {
        let ok = false;
        try {
            ok = await binRestore(x);
        } catch (e) {
            console.error('[重生成拼接] 恢复失败', e);
        }
        if (!ok) return toastr.error('没能恢复');
        toastr.success(`「${x.label}」已恢复`);
    }
    await binDrop([id]);
    binRender();
}

const FAV_KEY = 'favs';
const FAV_PREVIEW = 60;
const fav = { q: '', open: null, raw: false, timer: 0, qt: 0 };

const favChatId = () => String(ctx().getCurrentChatId?.() || '');
const favDate = m => String(m?.send_date ?? '');

async function favAll() {
    const v = await idbGet(FAV_KEY);
    return Array.isArray(v) ? v : [];
}

function favChatLabel() {
    const c = ctx();
    const who = c.groupId ? c.groups?.find(g => g.id === c.groupId)?.name : c.characters?.[c.characterId]?.name;
    return [who || c.name2, favChatId()].filter(Boolean).join(' · ');
}

const favMatch = (f, m, i) => !!m && favDate(m) === f.date && (m.name || '') === f.name && (i === f.mesid || !!f.date);

function favLive(f) {
    const chat = ctx().chat || [];
    if (f.chat !== favChatId()) return null;
    if (favMatch(f, chat[f.mesid], f.mesid)) return { i: f.mesid, m: chat[f.mesid] };
    const i = f.date ? chat.findIndex((m, k) => favMatch(f, m, k)) : -1;
    return i >= 0 ? { i, m: chat[i] } : null;
}

async function favFind(id) {
    const m = ctx().chat?.[id];
    const chat = favChatId();
    return m ? (await favAll()).find(f => f.chat === chat && favMatch(f, m, id)) || null : null;
}

async function favRemove(f) {
    if (!(await binAdd({ type: 'fav', label: `${f.name || '（无名）'} · 第 ${f.mesid} 楼`, sub: f.chatLabel, data: f }))) {
        toastr.error('没能放进回收站，为了安全没有取消');
        return false;
    }
    await idbPut(FAV_KEY, (await favAll()).filter(y => y.id !== f.id));
    favMarksSoon();
    return true;
}

async function favToggle(id) {
    const c = ctx();
    const m = c.chat?.[id];
    if (!m) return;
    const hit = await favFind(id);
    if (hit) {
        if (await favRemove(hit)) toastr.info('取消收藏了，回收站里能找回');
        return;
    }
    const item = { id: pzUid(), chat: favChatId(), chatLabel: favChatLabel(), mesid: id, date: favDate(m), name: m.name || '', user: !!m.is_user, mes: String(m.mes ?? ''), at: Date.now() };
    if (!(await idbPut(FAV_KEY, [item, ...(await favAll())]))) return toastr.error('没能收藏');
    toastr.success(`收藏了第 ${id} 楼，在插件的「收藏」里看`);
    favMarksSoon();
}

function favMarksSoon() {
    clearTimeout(fav.timer);
    fav.timer = setTimeout(favMarks, 100);
}

async function favMarks() {
    const chat = favChatId();
    const list = (await favAll()).filter(f => f.chat === chat);
    const c = ctx();
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const i = Number(el.getAttribute('mesid'));
        const m = c.chat?.[i];
        const on = list.some(f => favMatch(f, m, i));
        el.classList.toggle('rs_faved', on);
        el.querySelectorAll('.rs_fav_btn').forEach(b => {
            b.classList.toggle('fa-solid', on);
            b.classList.toggle('fa-regular', !on);
            b.title = on ? '取消收藏' : '收藏这一楼';
        });
    });
}

function favBody(f, text, i) {
    if (fav.raw) return `<pre class="rs_fav_raw">${escapeHtml(text)}</pre>`;
    try {
        const html = ctx().messageFormatting?.(text, f.name, false, f.user, i ?? undefined);
        if (typeof html === 'string') return `<div class="mes_text rs_fav_text">${html}</div>`;
    } catch (e) {
        console.warn('[重生成拼接] 收藏排版失败', e);
    }
    return `<div class="rs_fav_text">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

async function favRender() {
    const $box = $('#rs_panel .rs_fav');
    const list = await favAll();
    if (fav.open) {
        const f = list.find(y => y.id === fav.open);
        if (!f) {
            fav.open = null;
            return favRender();
        }
        const live = favLive(f);
        if (live && String(live.m.mes ?? '') !== f.mes) {
            f.mes = String(live.m.mes ?? '');
            f.mesid = live.i;
            await idbPut(FAV_KEY, list);
        }
        const here = f.chat === favChatId();
        const note = live ? (live.m.is_system ? '这楼现在是隐藏的，内容照样能看' : '') : here ? '原楼已经删掉了，显示的是收藏时的内容' : `在别的聊天（${f.chatLabel || f.chat}），显示的是最后看到的内容`;
        $box.html(`
<div class="rs_bar rs_fav_head"><span class="rs_icon rs_fav_back fa-solid fa-chevron-left" title="返回"></span><div class="rs_bar_title">${escapeHtml(f.name || '（无名）')} · 第 ${live ? live.i : f.mesid} 楼</div><div class="rs_bar_spacer"></div>
  <span class="rs_icon rs_fav_act fa-solid ${fav.raw ? 'fa-align-left' : 'fa-code'}" data-a="raw" title="${fav.raw ? '看排版' : '看原文'}"></span>
  <span class="rs_icon rs_fav_act fa-solid fa-copy" data-a="copy" title="复制"></span>
  ${live ? '<span class="rs_icon rs_fav_act fa-solid fa-location-arrow" data-a="jump" title="跳到聊天里这楼"></span>' : ''}
  <span class="rs_icon rs_fav_act fa-solid fa-star" data-a="del" title="取消收藏"></span>
</div>
${note ? `<div class="rs_fav_note">${escapeHtml(note)}</div>` : ''}
<div class="rs_fav_read">${favBody(f, f.mes, live?.i)}</div>`);
        return;
    }
    if (!$box.find('.rs_fav_q').length) {
        $box.html(`<div class="rs_pz_filter"><input type="text" class="rs_fav_q" placeholder="搜收藏的内容、名字、聊天"></div><div class="rs_pz_list rs_fav_list"></div>`);
        $box.find('.rs_fav_q').val(fav.q);
    }
    const q = fav.q.toLowerCase();
    const chat = favChatId();
    const shown = list.filter(f => !q || `${f.name} ${f.chatLabel} ${f.mes}`.toLowerCase().includes(q));
    shown.sort((a, b) => (b.chat === chat) - (a.chat === chat) || (a.chat === b.chat && a.chat === chat ? a.mesid - b.mesid : b.at - a.at));
    const row = f => {
        const live = favLive(f);
        const tag = f.chat !== chat ? '别的聊天' : !live ? '原楼已删' : live.m.is_system ? '已隐藏' : '';
        return `<div class="rs_pz_row rs_fav_row" data-id="${f.id}"><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(f.name || '（无名）')} · 第 ${live ? live.i : f.mesid} 楼</span>${tag ? `<span class="rs_pz_cat_tag">${tag}</span>` : ''}</div><div class="rs_pz_pv">${escapeHtml(previewText(live ? live.m.mes : f.mes, FAV_PREVIEW))}</div>${f.chat !== chat ? `<div class="rs_pz_pv">${escapeHtml(f.chatLabel || f.chat)}</div>` : ''}</div></div>`;
    };
    $box.find('.rs_fav_list').html(shown.map(row).join('') || `<div class="rs_empty">${list.length ? '没找到' : '还没有收藏。点楼层的「…」菜单里的星星图标就能收藏，隐藏或删掉原楼以后这里照样能看。'}</div>`);
}

async function favAct(a) {
    const f = (await favAll()).find(y => y.id === fav.open);
    if (!f) return;
    if (a === 'raw') {
        fav.raw = !fav.raw;
        return favRender();
    }
    if (a === 'copy') return copyText(favLive(f)?.m.mes ?? f.mes);
    if (a === 'jump') {
        const live = favLive(f);
        if (!live) return;
        await closePanel(true);
        return jumpTo(live.i);
    }
    if (a === 'del') {
        if (!(await favRemove(f))) return;
        toastr.info('取消收藏了，回收站里能找回');
        fav.open = null;
        favRender();
    }
}

const SHELF_TABS = { char: [['all', '全部'], ['tag', '标签'], ['fav', '收藏'], ['recent', '最近']], persona: [['all', '全部'], ['tag', '标题'], ['fav', '收藏']] };
const SHELF_RECENT = 30;
const SHELF_STACK = 3;
const SHELF_UNTAGGED = '@none';
const SHELF_DOTS = '<span class="rs_shelf_dots" title="更多操作">···</span>';
const SHELF_HOLD = 450;

const shelf = { kind: '', tab: 'all', folder: null, view: 'grid', selMode: false, sel: new Set(), tagFor: [], moveFrom: null, menuFolder: null, chatsOf: null, chats: null, menuChat: null, bust: {} };

function shelfThumb(kind, id) {
    const c = ctx();
    let url;
    try { url = c.getThumbnailUrl(kind === 'char' ? 'avatar' : 'persona', id); } catch { url = kind === 'char' ? `/characters/${encodeURIComponent(id)}` : `/User Avatars/${encodeURIComponent(id)}`; }
    const t = shelf.bust?.[id];
    return t && !url.startsWith('data:') ? `${url}${url.includes('?') ? '&' : '?'}t=${t}` : url;
}

function shelfPersonaMeta() {
    const s = settings();
    s.personaFav = s.personaFav || [];
    if (s.personaTags) {
        const pu = ctx().powerUserSettings || {};
        pu.persona_descriptions = pu.persona_descriptions || {};
        Object.entries(s.personaTags).forEach(([id, tags]) => {
            if (tags?.[0] && !personaTitle(pu, id)) pu.persona_descriptions[id] = { ...(pu.persona_descriptions[id] || {}), title: tags[0] };
        });
        delete s.personaTags;
        ctx().saveSettingsDebounced();
    }
    return s;
}

function personaTitle(pu, id) {
    return String(pu.persona_descriptions?.[id]?.title ?? '').trim();
}

async function personaSetTitle(id, title) {
    const { pu } = await personaInfo();
    pu.persona_descriptions = pu.persona_descriptions || {};
    pu.persona_descriptions[id] = { ...(pu.persona_descriptions[id] || {}), title };
}

async function personaRefresh() {
    ctx().saveSettingsDebounced();
    try { (await import('/scripts/personas.js')).getUserAvatars?.(true); } catch { }
}

function shelfTags() {
    if (shelf.kind === 'char') return (ctx().tags || []).map(t => ({ id: t.id, name: String(t.name) }));
    const pu = ctx().powerUserSettings || {};
    const names = [...new Set(Object.keys(pu.personas || {}).map(id => personaTitle(pu, id)).filter(Boolean))];
    return names.sort((a, b) => a.localeCompare(b, 'zh')).map(n => ({ id: n, name: n }));
}

async function shelfItems() {
    const c = ctx();
    if (shelf.kind === 'char') {
        const cur = currentChar()?.avatar;
        const map = c.tagMap || {};
        return (c.characters || []).filter(x => x?.avatar).map(x => ({
            id: x.avatar,
            name: String(x.name ?? x.avatar),
            fav: x.fav === true || x.fav === 'true' || x.data?.extensions?.fav === true,
            tags: map[x.avatar] || [],
            last: Number(x.date_last_chat) || 0,
            cur: x.avatar === cur,
        }));
    }
    const { pu, cur } = await personaInfo();
    const meta = shelfPersonaMeta();
    return Object.entries(pu.personas || {}).map(([id, name]) => ({
        id,
        name: String(name ?? id),
        fav: meta.personaFav.includes(id),
        tags: personaTitle(pu, id) ? [personaTitle(pu, id)] : [],
        last: 0,
        cur: id === cur,
    }));
}

function shelfFilter(items) {
    const q = String($('#rs_panel .rs_shelf_q').val() || '').trim().toLowerCase();
    let list = items.filter(x => !q || x.name.toLowerCase().includes(q));
    if (shelf.tab === 'fav') list = list.filter(x => x.fav);
    if (shelf.tab === 'tag' && shelf.folder) list = list.filter(x => shelf.folder === SHELF_UNTAGGED ? !x.tags.length : x.tags.includes(shelf.folder));
    if (shelf.tab === 'recent') return list.filter(x => x.last).sort((a, b) => b.last - a.last).slice(0, SHELF_RECENT);
    return list.sort((a, b) => b.fav - a.fav || a.name.localeCompare(b.name, 'zh'));
}

function shelfCover(x, labels) {
    const sel = shelf.sel.has(x.id);
    const label = labels.get(x.id) || x.name;
    const badge = `${x.fav ? '<span class="rs_shelf_fav fa-solid fa-star"></span>' : ''}${x.cur ? '<span class="rs_shelf_cur">当前</span>' : ''}`;
    const cb = shelf.selMode ? `<span class="rs_cb${sel ? ' rs_cb_on' : ''}"></span>` : '';
    if (shelf.view === 'list') {
        return `<div class="rs_shelf_row${sel ? ' rs_pz_sel' : ''}" data-id="${escapeHtml(x.id)}">${cb}<img class="rs_shelf_avatar" loading="lazy" src="${escapeHtml(shelfThumb(shelf.kind, x.id))}" alt=""><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(label)}</span>${badge}</div><div class="rs_pz_pv">${escapeHtml(shelfTagNames(x).join('、') || '未分类')}</div></div>${SHELF_DOTS}</div>`;
    }
    return `<div class="rs_shelf_book${sel ? ' rs_pz_sel' : ''}" data-id="${escapeHtml(x.id)}"><div class="rs_shelf_img"><img loading="lazy" src="${escapeHtml(shelfThumb(shelf.kind, x.id))}" alt="">${badge}${cb}${shelf.selMode ? '' : SHELF_DOTS}</div><div class="rs_shelf_name">${escapeHtml(label)}</div></div>`;
}

function shelfTagNames(x) {
    const tags = new Map(shelfTags().map(t => [t.id, t.name]));
    return x.tags.map(id => tags.get(id)).filter(Boolean);
}

function shelfFolder(id, name, members) {
    const covers = members.slice(0, SHELF_STACK).map((x, i) => `<img loading="lazy" style="--i:${i}" src="${escapeHtml(shelfThumb(shelf.kind, x.id))}" alt="">`).reverse().join('');
    return `<div class="rs_shelf_book rs_shelf_folder" data-folder="${escapeHtml(id)}"><div class="rs_shelf_img rs_shelf_stack">${covers || '<span class="rs_shelf_empty_cover fa-solid fa-tag"></span>'}<span class="rs_shelf_count">×${members.length}</span>${id === SHELF_UNTAGGED ? '' : SHELF_DOTS}</div><div class="rs_shelf_name rs_shelf_tab_label">${escapeHtml(name)}</div></div>`;
}

const CHAT_PREVIEW = 60;

function chatTime(v) {
    const t = typeof v === 'number' ? v : Date.parse(String(v || '').replace(/@(\d+)h(\d+)m(\d+)s(\d*)ms/, ' $1:$2:$3'));
    if (!Number.isFinite(t) || !t) return '';
    const d = new Date(t);
    const z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}

async function shelfLoadChats() {
    const res = await apiPost('/api/characters/chats', { avatar_url: shelf.chatsOf });
    const data = res?.ok ? await res.json().catch(() => null) : null;
    const list = Array.isArray(data) ? data : Object.values(data && !data.error ? data : {});
    shelf.chats = list.filter(x => x?.file_name).map(x => ({ ...x, file_id: String(x.file_id ?? x.file_name).replace(/\.jsonl$/, '') }))
        .sort((a, b) => (Date.parse(b.last_mes) || Number(b.last_mes) || 0) - (Date.parse(a.last_mes) || Number(a.last_mes) || 0));
}

async function shelfOpenChats(avatar) {
    shelf.chatsOf = avatar;
    shelf.chats = null;
    shelf.selMode = false;
    shelf.sel.clear();
    shelfCloseSheet();
    $('#rs_panel .rs_shelf_q').val('');
    await shelfRender();
    await shelfLoadChats();
    await shelfRender();
}

function shelfChatsHtml() {
    const c = ctx();
    const ch = c.characters.find(x => x.avatar === shelf.chatsOf);
    const curId = ch === currentChar() ? c.getCurrentChatId?.() : null;
    const q = String($('#rs_panel .rs_shelf_q').val() || '').trim().toLowerCase();
    $('#rs_panel .rs_shelf_head').html(`<div class="rs_shelf_crumb rs_shelf_chatcrumb"><span class="rs_icon rs_shelf_chatsback fa-solid fa-chevron-left"></span><b>${escapeHtml(ch?.name ?? '')} 的聊天</b><div class="rs_bar_spacer"></div><span class="rs_pz_pv">${shelf.chats ? `${shelf.chats.length} 个` : ''}</span></div>`);
    if (!shelf.chats) return '<div class="rs_empty">正在读取……</div>';
    const rows = shelf.chats.filter(x => !q || [x.file_id, x.mes].some(v => String(v || '').toLowerCase().includes(q)));
    return rows.map(x => {
        const tags = [x.file_id === curId && '正在打开', x.file_id === ch?.chat && x.file_id !== curId && '上次用的'].filter(Boolean).map(t => `<span class="rs_pz_tag rs_pz_same">${t}</span>`).join('');
        const pv = [chatTime(x.last_mes), `${x.chat_items || 0} 条`, x.file_size].filter(Boolean).join(' · ');
        return `<div class="rs_shelf_row rs_shelf_chat" data-chat="${escapeHtml(x.file_id)}"><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(x.file_id)}</span>${tags}</div><div class="rs_pz_pv">${escapeHtml(pv)}</div><div class="rs_pz_pv">${escapeHtml(String(x.mes || '').replace(/\s+/g, ' ').slice(0, CHAT_PREVIEW))}</div></div>${SHELF_DOTS}</div>`;
    }).join('') || `<div class="rs_empty">${q ? '没有符合的聊天' : '还没有聊天'}</div>`;
}

function shelfChatMenu(fid) {
    const x = shelf.chats?.find(y => y.file_id === fid);
    if (!x) return;
    shelf.menuChat = fid;
    $('#rs_panel .rs_shelf_sheet').addClass('rs_on').html(`
<div class="rs_shelf_sheet_in">
  <div class="rs_shelf_sheet_top"><div><b>${escapeHtml(fid)}</b><div class="rs_pz_pv">${escapeHtml(chatTime(x.last_mes))} · ${x.chat_items || 0} 条</div></div></div>
  <div class="rs_shelf_acts">
    <div class="rs_shelf_act" data-c="open">打开</div>
    <div class="rs_shelf_act" data-c="ren">改名</div>
    <div class="rs_shelf_act rs_shelf_danger" data-c="del">删除</div>
    <div class="rs_shelf_act rs_shelf_cancel" data-a="close">取消</div>
  </div>
</div>`);
}

async function shelfChatAct(a, fid) {
    shelfCloseSheet();
    const c = ctx();
    const avatar = shelf.chatsOf;
    const chid = c.characters.findIndex(x => x.avatar === avatar);
    const ch = c.characters[chid];
    if (!ch) return;
    const isCurChar = ch === currentChar();
    const isOpen = isCurChar && c.getCurrentChatId?.() === fid;
    if (a === 'open') {
        shelfClose();
        await closePanel();
        if (!isCurChar) await c.selectCharacterById(chid);
        if (c.getCurrentChatId?.() !== fid) await c.openCharacterChat(fid);
        return;
    }
    if (a === 'ren') {
        const name = String(await pzAskText('聊天新名字', fid)).replace(/\.jsonl$/, '').trim();
        if (!name || name === fid) return;
        if (shelf.chats.some(x => x.file_id === name)) return toastr.warning('已经有同名的聊天了');
        const res = await apiPost('/api/chats/rename', { is_group: false, avatar_url: avatar, original_file: `${fid}.jsonl`, renamed_file: `${name}.jsonl` });
        const data = res?.ok ? await res.json().catch(() => ({})) : null;
        if (!data || data.error) return toastr.error('改名失败');
        const next = data.sanitizedFileName || name;
        if (ch.chat === fid) {
            ch.chat = next;
            await postCharUpdate({ avatar, chat: next });
            if (isCurChar) $('#selected_chat_pole').val(next);
        }
        if (isOpen) await c.reloadCurrentChat?.();
        toastr.success('改好了');
    }
    if (a === 'del') {
        if (isOpen) return toastr.warning('这个聊天正开着，先切到别的聊天再删');
        if (!(await askConfirm(`删除聊天「${fid}」？可以在回收站找回`))) return;
        const ok = await ccRemove({ file_id: fid, file_name: `${fid}.jsonl`, avatar, owner: ch.name });
        if (!ok) return toastr.error('删除失败');
        toastr.success('删掉了');
    }
    await shelfLoadChats();
    await shelfRender();
}

async function shelfRender() {
    if (shelf.chatsOf) {
        $('#rs_panel .rs_shelf_grid').addClass('rs_shelf_list').html(shelfChatsHtml());
        $('#rs_panel .rs_shelf_bulk').removeClass('rs_on');
        $('#rs_panel .rs_shelf_tabs').hide();
        $('#rs_panel .rs_shelf_q').attr('placeholder', '搜索聊天名或内容');
        return;
    }
    $('#rs_panel .rs_shelf_tabs').show();
    $('#rs_panel .rs_shelf_q').attr('placeholder', '搜索名字');
    const items = await shelfItems();
    const tabs = SHELF_TABS[shelf.kind];
    if (!tabs.some(([t]) => t === shelf.tab)) shelf.tab = 'all';
    $('#rs_panel .rs_shelf_tabs').html(tabs.map(([t, n]) => `<span class="${shelf.tab === t ? 'rs_on' : ''}" data-t="${t}">${n}</span>`).join(''));
    $('#rs_panel .rs_shelf_title').text('书架');
    $('#rs_panel .rs_shelf_view').toggleClass('fa-list', shelf.view === 'grid').toggleClass('fa-table-cells-large', shelf.view === 'list');
    $('#rs_panel .rs_shelf_selbtn').toggleClass('rs_on', shelf.selMode).text(shelf.selMode ? '完成' : '选择');
    const labels = nameLabels(items, null);
    let html = '';
    let head = '';
    if (shelf.tab === 'tag' && !shelf.folder && !$('#rs_panel .rs_shelf_q').val()) {
        const tags = shelfTags();
        const folders = tags.map(t => [t.id, t.name, items.filter(x => x.tags.includes(t.id))]).filter(([, , m]) => m.length);
        const none = items.filter(x => !x.tags.length);
        html = folders.map(([id, name, m]) => shelfFolder(id, name, m)).join('') + (none.length ? shelfFolder(SHELF_UNTAGGED, shelf.kind === 'char' ? '未分类' : '没有标题', none) : '');
        if (!html) html = `<div class="rs_empty">${shelf.kind === 'char' ? '还没有标签。点一个角色，在“标签”里加上就会出现在这里。' : '还没有标题。点一个人设，在“标题”里设一个就会出现在这里。'}</div>`;
    } else {
        if (shelf.tab === 'tag' && shelf.folder) {
            const name = shelf.folder === SHELF_UNTAGGED ? (shelf.kind === 'char' ? '未分类' : '没有标题') : shelfTags().find(t => t.id === shelf.folder)?.name ?? '';
            head = `<div class="rs_shelf_crumb" data-folder="${escapeHtml(shelf.folder)}"><span class="rs_icon rs_shelf_up fa-solid fa-chevron-left"></span><b>${escapeHtml(name)}</b><div class="rs_bar_spacer"></div>${shelf.folder === SHELF_UNTAGGED ? '' : SHELF_DOTS}</div>`;
        }
        const list = shelfFilter(items);
        html = list.map(x => shelfCover(x, labels)).join('') || `<div class="rs_empty">${shelf.tab === 'fav' ? '还没有收藏' : shelf.tab === 'recent' ? '没有最近聊过的' : '没有符合的'}</div>`;
    }
    $('#rs_panel .rs_shelf_head').html(head);
    $('#rs_panel .rs_shelf_grid').toggleClass('rs_shelf_list', shelf.view === 'list' && !(shelf.tab === 'tag' && !shelf.folder)).html(html);
    $('#rs_panel .rs_shelf_bulk').toggleClass('rs_on', shelf.selMode).find('.rs_shelf_bcount').text(`已选 ${shelf.sel.size}`);
}

async function shelfOpen(kind) {
    shelf.chatsOf = null;
    if (shelf.kind !== kind) {
        shelf.tab = 'all';
        shelf.folder = null;
        $('#rs_panel .rs_shelf_q').val('');
    }
    shelf.kind = kind;
    shelf.sel.clear();
    shelf.selMode = false;
    shelfCloseSheet();
    $('#rs_panel').addClass('rs_shelf_on');
    await shelfRender();
}
function shelfClose() {
    shelf.chatsOf = null;
    shelfCloseSheet();
    $('#rs_panel').removeClass('rs_shelf_on');
}

function shelfCloseSheet() {
    $('#rs_panel .rs_shelf_sheet').removeClass('rs_on').empty();
}

async function shelfMore(solo) {
    const items = (await shelfItems()).filter(y => shelf.sel.has(y.id));
    if (!items.length) return toastr.info('先选几个');
    const ch = shelf.kind === 'char';
    const one = items.length === 1 ? items[0] : null;
    const allFav = items.every(x => x.fav);
    const btn = (a, t, cls = '') => `<div class="rs_shelf_act${cls}" data-a="${a}">${t}</div>`;
    const top = one
        ? `<img src="${escapeHtml(shelfThumb(shelf.kind, one.id))}" alt=""><div><b>${escapeHtml(one.name)}</b><div class="rs_pz_pv">${escapeHtml(shelfTagNames(one).join('、') || (ch ? '未分类' : '没有标题'))}</div></div>`
        : `<div><b>已选 ${items.length} 个</b></div>`;
    $('#rs_panel .rs_shelf_sheet').addClass('rs_on').html(`
<div class="rs_shelf_sheet_in">
  <div class="rs_shelf_sheet_top">${top}</div>
  <div class="rs_shelf_acts">
    ${one ? btn('edit', '编辑') : ''}
    ${one ? (ch ? btn('chat', '开始聊天') : btn('use', one.cur ? '已是当前' : '设为当前')) : ''}
    ${one && ch ? btn('chats', '聊天记录') : ''}
    ${btn('move', ch ? '移到标签' : '移到标题')}
    ${btn('dup', '复制一份')}
    ${btn('fav', allFav ? '取消收藏' : '收藏')}
    ${one ? btn('ren', '改名') : ''}
    ${one ? btn('avatar', '换头像') : ''}
    ${ch ? btn('tags', '加减标签') : ''}
    ${solo ? btn('multi', '多选') : ''}
    ${btn('del', '删除', ' rs_shelf_danger')}
    ${btn('close', '取消', ' rs_shelf_cancel')}
  </div>
</div>`);
}

async function shelfFolderMenu(fid) {
    const name = shelfTags().find(t => t.id === fid)?.name;
    if (!name) return;
    const ch = shelf.kind === 'char';
    shelf.menuFolder = fid;
    $('#rs_panel .rs_shelf_sheet').addClass('rs_on').html(`
<div class="rs_shelf_sheet_in">
  <div class="rs_shelf_sheet_top"><div><b>${escapeHtml(name)}</b><div class="rs_pz_pv">${ch ? '酒馆标签' : '用户设定标题'}</div></div></div>
  <div class="rs_shelf_acts">
    <div class="rs_shelf_act" data-f="tagren">改名</div>
    <div class="rs_shelf_act rs_shelf_danger" data-f="tagdel">${ch ? '删除标签' : '清掉标题'}</div>
    <div class="rs_shelf_act rs_shelf_cancel" data-a="close">取消</div>
  </div>
</div>`);
}
async function shelfMoveSheet() {
    const items = (await shelfItems()).filter(y => shelf.sel.has(y.id));
    if (!items.length) return toastr.info('先选几个');
    const ch = shelf.kind === 'char';
    const inTag = ch && shelf.tab === 'tag' && shelf.folder && shelf.folder !== SHELF_UNTAGGED ? shelf.folder : null;
    const cur = inTag ? shelfTags().find(t => t.id === inTag)?.name : null;
    const rows = shelfTags().filter(t => t.id !== inTag)
        .map(t => `<div class="rs_shelf_act" data-move="${escapeHtml(t.id)}">${escapeHtml(t.name)}</div>`).join('');
    const out = ch ? (inTag ? `移出「${escapeHtml(cur)}」` : '清空标签') : '清掉标题';
    $('#rs_panel .rs_shelf_sheet').addClass('rs_on').html(`
<div class="rs_shelf_sheet_in">
  <div class="rs_shelf_sheet_top"><div><b>把 ${items.length} 个移到</b><div class="rs_pz_pv">${ch ? (inTag ? `会从「${escapeHtml(cur)}」移到选的标签，其他标签不动` : '会加上选的标签，原来的标签不动') : '会换成选的标题'}</div></div></div>
  <div class="rs_shelf_acts">${rows}<div class="rs_shelf_act" data-move="">${out}</div></div>
  <div class="rs_pz_filter"><input type="text" class="rs_shelf_newmove" placeholder="${ch ? '新标签' : '新标题'}，回车移过去"></div>
  <div class="rs_shelf_acts"><div class="rs_shelf_act rs_shelf_cancel" data-a="close">取消</div></div>
</div>`);
    shelf.moveFrom = inTag;
}

async function shelfSnap() {
    const c = ctx();
    if (shelf.kind === 'char') return { kind: 'char', tags: structuredClone(c.tags), map: structuredClone(c.tagMap) };
    const { pu } = await personaInfo();
    return { kind: 'persona', titles: Object.fromEntries(Object.keys(pu.personas || {}).map(id => [id, personaTitle(pu, id)])) };
}

function shelfUndoToast(text, snap) {
    toastr.success(`${text}，点这里撤回`, '', {
        onclick: async () => {
            const c = ctx();
            if (snap.kind === 'char') {
                c.tags.splice(0, c.tags.length, ...snap.tags);
                Object.keys(c.tagMap).forEach(k => delete c.tagMap[k]);
                Object.assign(c.tagMap, snap.map);
            } else {
                for (const [id, t] of Object.entries(snap.titles)) await personaSetTitle(id, t);
            }
            c.saveSettingsDebounced();
            const kind = shelf.kind;
            shelf.kind = snap.kind;
            await shelfAfterTags();
            shelf.kind = kind;
            if (kind !== snap.kind) await shelfRender();
            toastr.info('已撤回');
        },
    });
}

async function shelfMoveTo(target) {
    const snap = await shelfSnap();
    const ch = shelf.kind === 'char';
    const from = shelf.moveFrom;
    let id = target;
    if (target && ch && !shelfTags().some(t => t.id === target)) {
        const c = ctx();
        const have = c.tags.find(t => t.name === target);
        if (have) id = have.id;
        else {
            id = pzUid();
            c.tags.push({ id, name: target, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: c.tags.length, color: '', color2: '', create_date: Date.now() });
        }
    }
    const items = (await shelfItems()).filter(y => shelf.sel.has(y.id));
    for (const x of items) {
        if (!ch) await shelfSaveTags(x.id, id ? [id] : []);
        else if (!id) await shelfSaveTags(x.id, from ? x.tags.filter(t => t !== from) : []);
        else await shelfSaveTags(x.id, [...new Set([...x.tags.filter(t => t !== from), id])]);
    }
    shelfCloseSheet();
    shelf.sel.clear();
    await shelfAfterTags();
    shelfUndoToast(`移好了 ${items.length} 个`, snap);
}
async function shelfTagSheet(ids) {
    const items = (await shelfItems()).filter(x => ids.includes(x.id));
    if (!items.length) return;
    const tags = shelfTags();
    const chip = t => {
        const n = items.filter(x => x.tags.includes(t.id)).length;
        return `<span class="rs_chip${n === items.length ? ' rs_on' : n ? ' rs_part' : ''}" data-tag="${escapeHtml(t.id)}">${escapeHtml(t.name)}</span>`;
    };
    shelf.tagFor = ids;
    $('#rs_panel .rs_shelf_sheet').addClass('rs_on').html(`
<div class="rs_shelf_sheet_in">
  <div class="rs_shelf_sheet_top"><div><b>${items.length === 1 ? `「${escapeHtml(items[0].name)}」的${shelf.kind === 'char' ? '标签' : '标题'}` : `给 ${items.length} 个${shelf.kind === 'char' ? '加减标签' : '设标题'}`}</b><div class="rs_pz_pv">${shelf.kind === 'char' ? '用的是酒馆自己的标签，点一下加上或去掉' : '用的是酒馆里的“用户设定标题”，每个人设只有一个，点一下换成它或去掉'}</div></div></div>
  <div class="rs_chips rs_shelf_tagchips">${tags.map(chip).join('') || '<span class="rs_pz_pv">还没有标签</span>'}</div>
  <div class="rs_pz_filter"><input type="text" class="rs_shelf_newtag" placeholder="${shelf.kind === 'char' ? '新标签名字' : '新标题'}，回车添加"><div class="menu_button rs_shelf_addtag">添加</div></div>
  <div class="rs_shelf_acts">${'<div class="rs_shelf_act rs_shelf_cancel" data-a="close">完成</div>'}</div>
</div>`);
}

async function shelfSaveTags(id, next) {
    const c = ctx();
    if (shelf.kind === 'char') c.tagMap[id] = next;
    else await personaSetTitle(id, next[next.length - 1] || '');
    c.saveSettingsDebounced();
}

async function shelfToggleTag(tagId) {
    const ids = shelf.tagFor || [];
    const items = (await shelfItems()).filter(x => ids.includes(x.id));
    const all = items.every(x => x.tags.includes(tagId));
    for (const x of items) await shelfSaveTags(x.id, all ? x.tags.filter(t => t !== tagId) : [...new Set([...x.tags, tagId])]);
    await shelfAfterTags();
    await shelfTagSheet(ids);
}

async function shelfAddTag() {
    const name = String($('#rs_panel .rs_shelf_newtag').val() || '').trim();
    if (!name) return;
    let id = name;
    if (shelf.kind === 'char') {
        const c = ctx();
        const have = c.tags.find(t => t.name === name);
        if (have) id = have.id;
        else {
            id = pzUid();
            c.tags.push({ id, name, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: c.tags.length, color: '', color2: '', create_date: Date.now() });
        }
    }
    const items = (await shelfItems()).filter(x => (shelf.tagFor || []).includes(x.id));
    for (const x of items) await shelfSaveTags(x.id, [...new Set([...x.tags, id])]);
    await shelfAfterTags();
    await shelfTagSheet(shelf.tagFor);
}

async function shelfAfterTags() {
    if (shelf.kind === 'char') {
        try {
            const tags = await import('/scripts/tags.js');
            tags.printTagFilters?.();
            const chid = ctx().characterId;
            if (chid !== undefined && chid !== null) tags.applyTagsOnCharacterSelect?.(chid);
            (await import('/script.js')).printCharactersDebounced?.();
        } catch { }
    } else await personaRefresh();
    await shelfRender();
}

async function shelfTagManage(a, id = shelf.folder) {
    if (!id || id === SHELF_UNTAGGED) return;
    const snap = await shelfSnap();
    const c = ctx();
    const name = shelfTags().find(t => t.id === id)?.name ?? id;
    if (a === 'tagren') {
        const next = await pzAskText('标签新名字', name);
        if (!next || next === name) return;
        if (shelf.kind === 'char') c.tags.find(t => t.id === id).name = next;
        else {
            for (const x of (await shelfItems()).filter(y => y.tags.includes(id))) await personaSetTitle(x.id, next);
            if (shelf.folder === id) shelf.folder = next;
        }
    } else {
        if (!(await askConfirm(shelf.kind === 'char' ? `删除标签「${name}」？只是去掉标签，角色本身不会删` : `清掉标题「${name}」？这些人设的标题会变成空的，人设本身不会删`))) return;
        if (shelf.kind === 'char') {
            c.tags.splice(c.tags.findIndex(t => t.id === id), 1);
            Object.keys(c.tagMap).forEach(k => { c.tagMap[k] = c.tagMap[k].filter(t => t !== id); });
        } else {
            for (const x of (await shelfItems()).filter(y => y.tags.includes(id))) await personaSetTitle(x.id, '');
        }
        if (shelf.folder === id) shelf.folder = null;
    }
    c.saveSettingsDebounced();
    await shelfAfterTags();
    shelfUndoToast(a === 'tagren' ? '改好了' : '清掉了', snap);
}

async function shelfSetFav(ids, on) {
    const c = ctx();
    if (shelf.kind === 'persona') {
        const meta = shelfPersonaMeta();
        meta.personaFav = on ? [...new Set([...meta.personaFav, ...ids])] : meta.personaFav.filter(x => !ids.includes(x));
        c.saveSettingsDebounced();
        return;
    }
    for (const id of ids) {
        const ch = c.characters.find(x => x.avatar === id);
        if (!ch) continue;
        if (await postCharUpdate({ avatar: id, fav: on, data: { extensions: { fav: on } } })) {
            ch.fav = on;
            if (ch.data?.extensions) ch.data.extensions.fav = on;
        }
    }
    try { (await import('/script.js')).printCharactersDebounced?.(); } catch { }
}

async function shelfRename(id) {
    const c = ctx();
    const x = (await shelfItems()).find(y => y.id === id);
    const name = await pzAskText('新名字', x?.name || '');
    if (!name || name === x?.name) return;
    if (shelf.kind === 'char') {
        if (!(await postCharUpdate({ avatar: id, name, data: { name } }))) return;
        const ch = c.characters.find(y => y.avatar === id);
        if (ch) {
            ch.name = name;
            if (ch.data) ch.data.name = name;
        }
        try { (await import('/script.js')).printCharactersDebounced?.(); } catch { }
    } else {
        const { pu, cur } = await personaInfo();
        pu.personas[id] = name;
        c.saveSettingsDebounced();
        if (id === cur) {
            try { (await import('/script.js')).setUserName?.(name); } catch { }
        }
        try { (await import('/scripts/personas.js')).getUserAvatars?.(true); } catch { }
    }
    toastr.success('改好了');
}

async function shelfDuplicate(id, quiet) {
    const c = ctx();
    if (shelf.kind === 'char') {
        const res = await apiPost('/api/characters/duplicate', { avatar_url: id });
        const data = res?.ok ? await res.json().catch(() => null) : null;
        if (!data?.path) return toastr.error('复制失败');
        if (c.tagMap[id]) c.tagMap[data.path] = [...c.tagMap[id]];
        c.saveSettingsDebounced();
        await c.getCharacters();
        if (!quiet) toastr.success('复制好了');
        return;
    }
    try {
        const blob = await (await fetch(`/User Avatars/${encodeURIComponent(id)}`)).blob();
        const form = new FormData();
        form.append('avatar', blob, 'avatar.png');
        const res = await formPost('/api/avatars/upload', form);
        const data = res?.ok ? await res.json() : null;
        if (!data?.path) throw new Error('upload');
        const { pu } = await personaInfo();
        pu.personas[data.path] = `${pu.personas[id] ?? id} 副本`;
        pu.persona_descriptions = pu.persona_descriptions || {};
        if (pu.persona_descriptions[id]) pu.persona_descriptions[data.path] = structuredClone(pu.persona_descriptions[id]);
        await personaRefresh();
        if (!quiet) toastr.success('复制好了');
    } catch (e) {
        console.error('[重生成拼接] 复制人设失败', e);
        toastr.error('复制失败');
    }
}

async function shelfDelete(ids) {
    const c = ctx();
    const items = (await shelfItems()).filter(x => ids.includes(x.id));
    if (!items.length) return;
    const cur = items.find(x => x.cur);
    if (cur) return toastr.warning(`「${cur.name}」正在用，先换成别的再删`);
    const what = shelf.kind === 'char' ? '角色' : '人设';
    const tip = shelf.kind === 'char' ? '角色卡会放进回收站，但它的聊天记录会一起删掉，恢复后不会回来' : '人设会放进回收站';
    if (!(await askConfirm(`删除${items.length === 1 ? `「${items[0].name}」` : `${items.length} 个${what}`}？${tip}`))) return;
    let n = 0;
    const gone = [];
    for (const x of items) {
        if (shelf.kind === 'char') {
            const card = await apiPost('/api/characters/export', { format: 'png', avatar_url: x.id });
            const blob = card?.ok ? await card.blob() : null;
            if (!blob || !(await binAdd({ type: 'card', label: x.name, sub: '角色卡', data: { avatar: x.id, blob, tags: c.tagMap[x.id] || [] } }))) {
                toastr.error(`「${x.name}」没能备份进回收站，为了安全没有删`);
                continue;
            }
            const res = await apiPost('/api/characters/delete', { avatar_url: x.id, delete_chats: true });
            if (!res?.ok) continue;
            delete c.tagMap[x.id];
            gone.push({ avatar: x.id, world: c.characters.find(y => y.avatar === x.id)?.data?.extensions?.world || '' });
            n++;
        } else {
            const { pu } = await personaInfo();
            const img = await fetch(`/User Avatars/${encodeURIComponent(x.id)}`).then(r => (r.ok ? r.blob() : null)).catch(() => null);
            const meta = shelfPersonaMeta();
            if (!(await binAdd({ type: 'persona', label: x.name, sub: '用户人设', data: { avatar: x.id, blob: img, name: x.name, desc: pu.persona_descriptions?.[x.id] ?? null, fav: meta.personaFav.includes(x.id) } }))) {
                toastr.error(`「${x.name}」没能备份进回收站，为了安全没有删`);
                continue;
            }
            const res = await apiPost('/api/avatars/delete', { avatar: x.id });
            if (!res?.ok) continue;
            delete pu.personas[x.id];
            if (pu.persona_descriptions) delete pu.persona_descriptions[x.id];
            meta.personaFav = meta.personaFav.filter(y => y !== x.id);
            n++;
        }
    }
    c.saveSettingsDebounced();
    if (shelf.kind === 'char') await c.getCharacters();
    else {
        try { (await import('/scripts/personas.js')).getUserAvatars?.(true); } catch { }
    }
    ids.forEach(id => shelf.sel.delete(id));
    toastr[n === items.length ? 'success' : 'warning'](`删掉了 ${n} 个${n < items.length ? `，${items.length - n} 个没删成` : ''}`);
    if (gone.length) await shelfDropBooks(gone);
}

async function shelfDropBooks(gone) {
    const books = await wiOrphanBooks(gone);
    if (!books.length) return;
    if (!(await askConfirm(`${books.map(b => `「${b}」`).join('')}只给刚删的卡用，要一起删掉吗？会放进回收站，${BIN_DAYS} 天内能恢复`))) return;
    let n = 0;
    for (const b of books) if (await wiRemoveBook(b)) n++;
    await syncLists(true);
    toastr[n === books.length ? 'success' : 'warning'](`删掉了 ${n} 本世界书${n < books.length ? `，${books.length - n} 本没删成` : ''}`);
}

const CROP_W = 200;
const CROP_H = 300;
const CROP_ZOOM_MAX = 4;
const crop = { id: null, file: null, url: '', nw: 0, nh: 0, zoom: 1, ox: 0, oy: 0, drag: null };

function cropScale() {
    return Math.max(CROP_W / crop.nw, CROP_H / crop.nh) * crop.zoom;
}

function cropClamp() {
    const s = cropScale();
    crop.ox = Math.min(0, Math.max(CROP_W - crop.nw * s, crop.ox));
    crop.oy = Math.min(0, Math.max(CROP_H - crop.nh * s, crop.oy));
}

function cropPaint() {
    const s = cropScale();
    cropClamp();
    $('#rs_panel .rs_crop_img').css({ width: crop.nw * s + 'px', height: crop.nh * s + 'px', transform: `translate(${crop.ox}px, ${crop.oy}px)` });
}

function cropZoom(z) {
    const s0 = cropScale();
    const cx = (CROP_W / 2 - crop.ox) / s0;
    const cy = (CROP_H / 2 - crop.oy) / s0;
    crop.zoom = Math.min(CROP_ZOOM_MAX, Math.max(1, z));
    const s = cropScale();
    crop.ox = CROP_W / 2 - cx * s;
    crop.oy = CROP_H / 2 - cy * s;
    cropPaint();
}

async function cropStart(file) {
    if (!file || !shelf.sel.size) return;
    URL.revokeObjectURL(crop.url);
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
        await new Promise((ok, bad) => {
            img.onload = ok;
            img.onerror = bad;
            img.src = url;
        });
    } catch {
        return toastr.error('这张图读不出来');
    }
    Object.assign(crop, { id: [...shelf.sel][0], file, url, nw: img.naturalWidth, nh: img.naturalHeight, zoom: 1 });
    const s = cropScale();
    crop.ox = (CROP_W - crop.nw * s) / 2;
    crop.oy = (CROP_H - crop.nh * s) / 2;
    $('#rs_panel .rs_shelf_sheet').addClass('rs_on').html(`
<div class="rs_shelf_sheet_in">
  <div class="rs_shelf_sheet_top"><div><b>换头像</b><div class="rs_pz_pv">拖动图片调整位置，滑块放大缩小</div></div></div>
  <div class="rs_crop_frame" style="width:${CROP_W}px;height:${CROP_H}px"><img class="rs_crop_img" src="${url}" alt=""></div>
  <input type="range" class="rs_crop_zoom" min="1" max="${CROP_ZOOM_MAX}" step="0.01" value="1">
  <div class="rs_shelf_acts">
    <div class="rs_shelf_act" data-crop="again">换一张图</div>
    <div class="rs_shelf_act" data-crop="ok">确定</div>
    <div class="rs_shelf_act rs_shelf_cancel" data-a="close">取消</div>
  </div>
</div>`);
    cropPaint();
}

async function cropSave() {
    const c = ctx();
    const s = cropScale();
    const box = { x: Math.round(-crop.ox / s), y: Math.round(-crop.oy / s), width: Math.round(CROP_W / s), height: Math.round(CROP_H / s) };
    const q = `?crop=${encodeURIComponent(JSON.stringify(box))}`;
    const form = new FormData();
    form.append('avatar', crop.file, crop.file.name || 'avatar.png');
    let res;
    if (shelf.kind === 'char') {
        form.append('avatar_url', crop.id);
        res = await formPost(`/api/characters/edit-avatar${q}`, form);
    } else {
        form.append('overwrite_name', crop.id);
        res = await formPost(`/api/avatars/upload${q}`, form);
    }
    if (!res?.ok) return toastr.error('换头像失败');
    const urls = [shelfThumb(shelf.kind, crop.id), shelf.kind === 'char' ? `/characters/${encodeURIComponent(crop.id)}` : `/User Avatars/${encodeURIComponent(crop.id)}`];
    await Promise.all(urls.map(u => fetch(u, { cache: 'reload' }).catch(() => null)));
    shelf.bust[crop.id] = Date.now();
    if (shelf.kind === 'char') {
        await c.getCharacters();
        const enc = encodeURIComponent(crop.id);
        $('img').filter(function () { return this.src.includes(enc) || this.src.includes(crop.id); }).each(function () {
            const u = new URL(this.src, location.href);
            u.searchParams.set('t', String(Date.now()));
            this.src = u.href;
        });
    } else await personaRefresh();
    URL.revokeObjectURL(crop.url);
    shelfCloseSheet();
    if (!shelf.selMode) shelf.sel.clear();
    await shelfRender();
    toastr.success('头像换好了');
}

async function shelfEdit(id) {
    shelfClose();
    await switchTarget(() => (shelf.kind === 'char' ? charTarget('description', id) : personaTarget(id)));
}

async function shelfAct(a) {
    const ids = [...shelf.sel];
    const id = ids[0];
    const c = ctx();
    const done = () => {
        if (!shelf.selMode) shelf.sel.clear();
    };
    if (a === 'avatar') return $('#rs_panel .rs_shelf_file').val('').trigger('click');
    if (a === 'close' || !id) {
        shelfCloseSheet();
        done();
        return shelfRender();
    }
    if (a === 'edit') return shelfEdit(id);
    if (a === 'move') return shelfMoveSheet();
    if (a === 'chats') return shelfOpenChats(id);
    if (a === 'tags') return shelfTagSheet(ids);
    if (a === 'multi') {
        shelf.selMode = true;
        shelfCloseSheet();
        return shelfRender();
    }
    if (a === 'chat') {
        const chid = c.characters.findIndex(x => x.avatar === id);
        if (chid < 0) return;
        shelfClose();
        await closePanel();
        return c.selectCharacterById(chid);
    }
    shelfCloseSheet();
    if (a === 'use') {
        try {
            await (await import('/scripts/personas.js')).setUserAvatar?.(id);
        } catch (e) {
            console.error('[重生成拼接] 切换人设失败', e);
        }
    }
    if (a === 'fav') await shelfSetFav(ids, !(await shelfItems()).filter(x => shelf.sel.has(x.id)).every(x => x.fav));
    if (a === 'ren') await shelfRename(id);
    if (a === 'dup') {
        for (const x of ids) await shelfDuplicate(x, ids.length > 1);
        if (ids.length > 1) toastr.success(`复制了 ${ids.length} 个`);
        shelf.sel.clear();
    }
    if (a === 'del') await shelfDelete(ids);
    done();
    await shelfRender();
}async function shelfBulk(a) {
    if (a === 'all') {
        const all = (await shelfItems()).filter(x => $(`#rs_panel .rs_shelf_grid [data-id="${CSS.escape(x.id)}"]`).length);
        const every = all.length && all.every(x => shelf.sel.has(x.id));
        all.forEach(x => (every ? shelf.sel.delete(x.id) : shelf.sel.add(x.id)));
        return shelfRender();
    }
    if (!shelf.sel.size) return toastr.info('先选几个');
    if (a === 'more') return shelfMore(false);
    return shelfAct(a);
}

let shelfHold = null;

function shelfHoldStart(el, e) {
    clearTimeout(shelfHold?.t);
    shelfHold = {
        x: e.clientX,
        y: e.clientY,
        fired: false,
        t: setTimeout(() => {
            shelfHold.fired = true;
            shelf.selMode = true;
            shelf.sel.add(el.dataset.id);
            shelfRender();
        }, SHELF_HOLD),
    };
}

function shelfHoldMove(e) {
    if (shelfHold && Math.hypot(e.clientX - shelfHold.x, e.clientY - shelfHold.y) > 10) clearTimeout(shelfHold.t);
}async function shelfTap(el, target) {
    if (shelfHold?.fired) {
        shelfHold = null;
        return;
    }
    clearTimeout(shelfHold?.t);
    const folder = el.dataset.folder;
    const dots = target.closest('.rs_shelf_dots');
    if (folder) {
        if (dots) return shelfFolderMenu(folder);
        if (el.classList.contains('rs_shelf_crumb')) return;
        shelf.folder = folder;
        return shelfRender();
    }
    const id = el.dataset.id;
    if (!id) return;
    if (shelf.selMode) {
        flip(shelf.sel, id);
        return shelfRender();
    }
    if (dots) {
        shelf.sel = new Set([id]);
        return shelfMore(true);
    }
    return shelfEdit(id);
}const LOADERS = {
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
    preset: async () => {
        if (!(await pzPM())) {
            toastr.warning('这个版本的酒馆读不到预设');
            return null;
        }
        return { kind: 'preset', subtitle: '预设 · 世界书', initial: '' };
    },
    regex: async () => ({ kind: 'regex', subtitle: '正则脚本', initial: '' }),
    set: async () => ({ kind: 'set', subtitle: '插件设置', initial: '' }),
    fav: async () => ({ kind: 'fav', subtitle: '收藏的楼层', initial: '' }),
    bin: async () => ({ kind: 'bin', subtitle: '删掉的东西先放这里', initial: '' }),
};

let listSyncAt = 0;

async function syncLists(force) {
    if (!force && Date.now() - listSyncAt < 20000) return;
    listSyncAt = Date.now();
    const wi = await pzWorldApi();
    await Promise.allSettled([ctx().getCharacters?.(), wi?.updateWorldInfoList?.()]);
}

async function openFromBall() {
    if ($('#rs_overlay').length) return;
    await syncLists();
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
        .on('change', '#rs_panel .rs_pz_kind', function () { pzSetKind(this.value); })
        .on('change', '#rs_panel .rs_pz_src', async function () {
            if (!this.value) return;
            await pzSetSource(this.value);
            pzRender();
        })
        .on('change', '#rs_panel .rs_pz_file', function () {
            const f = this.files?.[0];
            this.value = '';
            if (f) pzLoadFile(f);
        })
        .on('input', '#rs_panel .rs_pz_q', function () {
            const side = this.dataset.side;
            if (side === 'pick') return pzRenderPick();
            pzRenderList(side);
            pzFitCards();
        })
        .on('click', '#rs_panel .rs_pz_all', pzSelectAll)
        .on('click', '#rs_panel .rs_pz_foldall', function () { pzFoldAll(this.dataset.side); })
        .on('click', '#rs_panel .rs_pz_tokbtn', pzToggleTok)
        .on('click', '#rs_panel .rs_shelf_open', function () { shelfOpen(this.dataset.kind); })
        .on('click', '#rs_panel .rs_shelf_back', shelfClose)
        .on('click', '#rs_panel .rs_shelf_tabs span', function () {
            shelf.tab = this.dataset.t;
            shelf.folder = null;
            shelfRender();
        })
        .on('input', '#rs_panel .rs_shelf_q', () => shelfRender())
        .on('click', '#rs_panel .rs_shelf_view', () => {
            shelf.view = shelf.view === 'grid' ? 'list' : 'grid';
            shelfRender();
        })
        .on('click', '#rs_panel .rs_shelf_selbtn', () => {
            shelf.selMode = !shelf.selMode;
            shelf.sel.clear();
            shelfRender();
        })
        .on('click', '#rs_panel .rs_shelf_grid [data-id], #rs_panel .rs_shelf_grid [data-folder], #rs_panel .rs_shelf_crumb', function (e) { shelfTap(this, e.target); })
        .on('pointerdown', '#rs_panel .rs_shelf_grid [data-id]', function (e) { if (!$(e.target).closest('.rs_shelf_dots').length) shelfHoldStart(this, e.originalEvent); })
        .on('pointermove', '#rs_panel .rs_shelf_grid', e => shelfHoldMove(e.originalEvent))
        .on('pointerup pointercancel', '#rs_panel .rs_shelf_grid', () => clearTimeout(shelfHold?.t))
        .on('contextmenu', '#rs_panel .rs_shelf_grid', e => e.preventDefault())
        .on('click', '#rs_panel .rs_shelf_grid [data-chat]', function (e) {
            const fid = this.dataset.chat;
            if ($(e.target).closest('.rs_shelf_dots').length) shelfChatMenu(fid);
            else shelfChatAct('open', fid);
        })
        .on('click', '#rs_panel .rs_shelf_act[data-c]', function () { shelfChatAct(this.dataset.c, shelf.menuChat); })
        .on('change', '#rs_panel .rs_shelf_file', function () { cropStart(this.files?.[0]); })
        .on('click', '#rs_panel .rs_shelf_act[data-crop]', function () {
            if (this.dataset.crop === 'again') $('#rs_panel .rs_shelf_file').val('').trigger('click');
            else cropSave();
        })
        .on('input', '#rs_panel .rs_crop_zoom', function () { cropZoom(Number(this.value)); })
        .on('pointerdown', '#rs_panel .rs_crop_frame', function (e) {
            e.preventDefault();
            crop.drag = { x: e.originalEvent.clientX, y: e.originalEvent.clientY, ox: crop.ox, oy: crop.oy };
            this.setPointerCapture?.(e.originalEvent.pointerId);
        })
        .on('pointermove', '#rs_panel .rs_crop_frame', e => {
            if (!crop.drag) return;
            crop.ox = crop.drag.ox + e.originalEvent.clientX - crop.drag.x;
            crop.oy = crop.drag.oy + e.originalEvent.clientY - crop.drag.y;
            cropPaint();
        })
        .on('pointerup pointercancel', '#rs_panel .rs_crop_frame', () => { crop.drag = null; })
        .on('click', '#rs_panel .rs_shelf_chatsback', async () => {
            shelf.chatsOf = null;
            $('#rs_panel .rs_shelf_q').val('');
            await shelfRender();
        })
        .on('click', '#rs_panel .rs_shelf_act[data-f]', function () {
            const f = shelf.menuFolder;
            shelfCloseSheet();
            shelfTagManage(this.dataset.f, f);
        })
        .on('click', '#rs_panel .rs_shelf_up', () => {
            shelf.folder = null;
            shelfRender();
        })
        .on('click', '#rs_panel .rs_shelf_bulk [data-b]', function () { shelfBulk(this.dataset.b); })
        .on('click', '#rs_panel .rs_shelf_act[data-a]', function () { shelfAct(this.dataset.a); })
        .on('click', '#rs_panel .rs_shelf_act[data-move]', function () { shelfMoveTo(this.dataset.move); })
        .on('keydown', '#rs_panel .rs_shelf_newmove', function (e) { if (e.key === 'Enter' && this.value.trim()) shelfMoveTo(this.value.trim()); })
        .on('click', '#rs_panel .rs_shelf_sheet', function (e) {
            if (e.target === this) shelfAct('close');
        })
        .on('click', '#rs_panel .rs_shelf_tagchips .rs_chip', function () { shelfToggleTag(this.dataset.tag); })
        .on('click', '#rs_panel .rs_shelf_addtag', shelfAddTag)
        .on('keydown', '#rs_panel .rs_shelf_newtag', e => { if (e.key === 'Enter') shelfAddTag(); })
        .on('click', '#rs_panel .rs_bin_list .rs_pz_card_btn', function () { binAct(this.closest('[data-id]').dataset.id, this.dataset.a); })
        .on('click', '#rs_panel .rs_bin .rs_chip', function () {
            bin.type = this.dataset.t;
            binRender();
        })
        .on('click', '#rs_panel .rs_bin_clear', async () => {
            if (!(await askConfirm('清空回收站？里面的东西就真的找不回来了'))) return;
            await idbPut(BIN_KEY, []);
            binRender();
        })
        .on('click', '#rs_panel .rs_pz_toksort', function () {
            pz.tokSort = !pz.tokSort;
            pzTokUi();
            pzRenderList('tgt');
            pzFitCards();
        })
        .on('click', '#rs_panel .rs_pz_schbtn', () => pzOpenSch(true))
        .on('click', '#rs_panel .rs_pz_sch_close', () => pzOpenSch(false))
        .on('click', '#rs_panel .rs_pz_sch_new', pzNewSch)
        .on('click', '#rs_panel .rs_pz_sch_row', function (e) {
            const b = $(e.target).closest('.rs_pz_card_btn')[0];
            pzSchAct(Number(this.dataset.i), b ? b.dataset.a : 'apply');
        })
        .on('click', '#rs_panel .rs_pz_cats .rs_chip', function () {
            const side = this.parentElement.dataset.side;
            pz.catf[side] = this.dataset.c;
            pzRenderList(side);
            pzFitCards();
            $(`#rs_panel .rs_pz_${side}_list`).scrollTop(0);
        })
        .on('click', '#rs_panel .rs_pz_src_list > .rs_pz_item, #rs_panel .rs_pz_tgt_list > .rs_pz_item', function (e) { pzTapItem(this, e.target); })
        .on('click', '#rs_panel .rs_pz_pick_list > .rs_pz_item', function (e) { pzPickTap(this, !$(e.target).closest('.rs_pz_pickit').length); })
        .on('click', '#rs_panel .rs_pz_pos', () => pzOpenPick(true))
        .on('click', '#rs_panel .rs_pz_pick_close', () => pzOpenPick(false))
        .on('input', '#rs_panel .rs_pz_cf', function () { pzCardInput(this); })
        .on('change', '#rs_panel .rs_pz_cf', function () { pzCardDone(this); })
        .on('click', '#rs_panel .rs_pz_card .rs_pz_card_btn', function () { pzCardAct(this); })
        .on('click', '#rs_panel .rs_pz_insert', () => pzInsert())
        .on('click', '#rs_panel .rs_rx_scope', () => rxOpenPick('scope'))
        .on('click', '#rs_panel .rs_rx_tabs span', function () { rxSetType(this.dataset.t); })
        .on('click', '#rs_panel .rs_rx_bmove', () => rxOpenPick('bmove'))
        .on('click', '#rs_panel .rs_rx_move', () => rxOpenPick('move'))
        .on('click', '#rs_panel .rs_rx_pick_close', rxClosePick)
        .on('input', '#rs_panel .rs_rx_pick_q', rxRenderPick)
        .on('click', '#rs_panel .rs_rx_pick_list > .rs_pz_item', function () { rxPickTap(this); })
        .on('change', '#rs_panel .rs_rx_file', function () {
            const fs = [...(this.files || [])];
            this.value = '';
            if (fs.length) rxImport(fs);
        })
        .on('input', '#rs_panel .rs_rx_q', rxRender)
        .on('click', '#rs_panel .rs_rx_add', () => rxOpenEd(null))
        .on('click', '#rs_panel .rs_rx_undo', () => rxStep(true))
        .on('click', '#rs_panel .rs_rx_redo', () => rxStep(false))
        .on('click', '#rs_panel .rs_rx_save', rxSave)
        .on('click', '#rs_panel .rs_rx_list .rs_pz_row', function (e) {
            if ($(e.target).closest('.rs_drag').length) return;
            if ($(e.target).closest('.rs_cb_hit').length) return rxToggleSel(this.dataset.k);
            if ($(e.target).closest('.rs_rx_toggle').length) return rxToggle(this.dataset.k);
            rxOpenEd(this.dataset.k);
        })
        .on('click', '#rs_panel .rs_rx_all', rxSelectAll)
        .on('click', '#rs_panel .rs_rx_bdel', rxDeleteSel)
        .on('click', '#rs_panel .rs_rx_bclear', () => {
            rx.sel.clear();
            rxRender();
        })
        .on('click', '#rs_panel .rs_rx_form .rs_chips > .rs_chip', function () {
            $(this).toggleClass('rs_on');
            rxTest();
        })
        .on('input', '#rs_panel .rs_rx_f, #rs_panel .rs_rx_test', rxTest)
        .on('input', '#rs_panel .rs_rx_reptext', () => {
            if (rt.tool === 'find') rtFindRender(false);
        })
        .on('change', '#rs_panel .rs_rx_reptext', () => {
            rtRefresh();
            if (rt.tool === 'img' || rt.tool === 'color') rtTbox();
        })
        .on('scroll', '#rs_panel .rs_rx_reptext', function () { $('#rs_panel .rs_rx_hl').scrollTop(this.scrollTop); })
        .on('click', '#rs_panel .rs_rx_tool', function () { rtTool(this.dataset.t); })
        .on('input', '#rs_panel .rs_rx_fq', () => {
            rt.fi = 0;
            rtFindRender(true);
        })
        .on('keydown', '#rs_panel .rs_rx_fq', e => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            rtFindAct(e.shiftKey ? 'prev' : 'next');
        })
        .on('click', '#rs_panel .rs_rx_fx', function () { rtFindAct(this.dataset.x); })
        .on('change', '#rs_panel .rs_rx_iu', function () { rtImgSet(this.closest('.rs_rx_irow'), this.value); })
        .on('keydown', '#rs_panel .rs_rx_iu', function (e) {
            if (e.key === 'Enter') this.blur();
        })
        .on('click', '#rs_panel .rs_rx_ipaste', function () { rtImgPaste(this.closest('.rs_rx_irow')); })
        .on('input', '#rs_panel .rs_rx_cin, #rs_panel .rs_rx_ca', function () { rtColorLive(this.closest('.rs_rx_crow')); })
        .on('change', '#rs_panel .rs_rx_cin, #rs_panel .rs_rx_ca', function () { rtColorDone(this.closest('.rs_rx_crow')); })
        .on('click', '#rs_panel .rs_rx_ed_act', function () { rxEdAct(this.dataset.a); })
        .on('change', '#rs_panel .rs_pz_tgt', function () { pzChangeTarget(this.value); })
        .on('change', '#rs_panel .rs_pz_tkind', function () { pzChangeTarget('', this.value); })
        .on('click', '#rs_panel .rs_pz_undo', () => pzStep(true))
        .on('click', '#rs_panel .rs_pz_redo', () => pzStep(false))
        .on('click', '#rs_panel .rs_pz_save', pzSave)
        .on('click', '#rs_panel .rs_pz_hunk_act', function () { pzTakeHunk(this); })
        .on('click', '#rs_wand_open', () => {
            $('#extensionsMenu').hide();
            openFromBall();
        })
        .on('click', '#rs_panel .rs_ball_toggle', () => setBallVisible(!settings().ball))
        .on('pointerdown', '#chat .mes_text', onMessageDown)
        .on('pointerup', '#chat .mes_text', onMessageUp)
        .on('pointercancel', '#chat .mes_text', () => { tapDown = null; })
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
        .on('click', '.rs_fav_btn', function () {
            favToggle(Number($(this).closest('.mes').attr('mesid')));
        })
        .on('click', '#rs_panel .rs_fav_row', function () {
            fav.open = this.dataset.id;
            favRender();
        })
        .on('click', '#rs_panel .rs_fav_back', () => {
            fav.open = null;
            favRender();
        })
        .on('click', '#rs_panel .rs_fav_act', function () { favAct(this.dataset.a); })
        .on('input', '#rs_panel .rs_fav_q', function () {
            fav.q = this.value;
            clearTimeout(fav.qt);
            fav.qt = setTimeout(favRender, 200);
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
            if (pick === 'char') ok = await switchTarget(() => charTarget(val, state.target.avatar));
            if (pick === 'charwho') ok = await switchTarget(() => charTarget(state.target.field?.startsWith('alt:') ? 'description' : state.target.field, val));
            if (pick === 'persona') ok = await switchTarget(() => personaTarget(val));
            if (pick === 'book') ok = await switchTarget(() => worldTarget(val));
            if (pick === 'entry') ok = await switchTarget(() => worldTarget(state.target.book, val));
            if (!ok && prev !== undefined) $(this).val(prev);
        })
        .on('click', '#rs_panel .rs_wi_toggle', toggleWorldEntry)
        .on('click', '#rs_panel .rs_wi_find', wfindToggle)
        .on('click', '#rs_panel .rs_wi_delbook', wiDeleteBook)
        .on('input', '#rs_panel .rs_wfind_q', () => {
            clearTimeout(wfind.timer);
            wfind.timer = setTimeout(wfindRender, 150);
        })
        .on('click', '#rs_panel .rs_wfind_all', function () {
            wfind.all = !wfind.all;
            $(this).toggleClass('rs_on', wfind.all);
            wfindRender();
        })
        .on('click', '#rs_panel .rs_wfind_row', function () { wfindGo(this); })
        .on('click', '#rs_panel .rs_ver_add', saveAsVersion)
        .on('click', '#rs_panel .rs_ver_del', deleteVersion)
        .on('click', '#rs_panel .rs_snap_clear', clearSnaps)
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
        .on('click', '#rs_panel .rs_ref_pane', clearSel)
        .on('focus', '#rs_panel .rs_body_text', function () { this.parentElement.classList.add('rs_focus'); })
        .on('blur', '#rs_panel .rs_body_text', function () {
            this.parentElement.classList.remove('rs_focus');
            renderBack();
        })
        .on('click', '#rs_panel .rs_lib_btn', () => toggleBox('lib'))
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
        .on('pointerdown', '#rs_panel .rs_grip', e => onGripDown(e.originalEvent, e.currentTarget))
        .on('pointermove', '#rs_panel .rs_grip', e => onGripMove(e.originalEvent))
        .on('pointerup pointercancel', '#rs_panel .rs_grip', onGripUp)
        .on('pointerdown', '#rs_panel .rs_drag', e => onDragDown(e.originalEvent, e.currentTarget))
        .on('pointermove', '#rs_panel .rs_drag', e => onDragMove(e.originalEvent))
        .on('pointerup pointercancel', '#rs_panel .rs_drag', onDragUp)
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

let selLock = null;

function selRelease(chat) {
    selLock?.classList.remove('rs_sel_mes');
    selLock = null;
    chat?.classList.remove('rs_selecting');
}

function guardSelection() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    const sel = window.getSelection();
    const typing = document.activeElement?.matches?.('textarea, input, [contenteditable="true"]');
    if (typing || !settings().selectGuard || !sel?.rangeCount || sel.isCollapsed) return selRelease(chat);
    if (!selLock || !selLock.isConnected) {
        const node = sel.anchorNode;
        const mes = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('#chat .mes');
        if (!mes) return selRelease(chat);
        selLock = mes;
        mes.classList.add('rs_sel_mes');
        chat.classList.add('rs_selecting');
    }
    const box = selLock.querySelector('.mes_text') || selLock;
    const r = sel.getRangeAt(0);
    if (box.contains(r.startContainer) && box.contains(r.endContainer)) return;
    const full = document.createRange();
    full.selectNodeContents(box);
    const nr = r.cloneRange();
    if (r.compareBoundaryPoints(Range.START_TO_START, full) < 0) nr.setStart(full.startContainer, full.startOffset);
    if (r.compareBoundaryPoints(Range.END_TO_END, full) > 0) nr.setEnd(full.endContainer, full.endOffset);
    if (nr.collapsed || nr.compareBoundaryPoints(Range.START_TO_END, full) < 0 || nr.compareBoundaryPoints(Range.END_TO_START, full) > 0) return;
    sel.removeAllRanges();
    sel.addRange(nr);
}
const JUMP_SHOW_SCREENS = 1;
const JUMP_GAP_PX = 8;
const JUMP_FLASH_MS = 1600;
const JUMP_LOAD_WAIT_MS = 3000;
const HOLD_START_PX = 80;
const HOLD_JUMP_PX = 120;
const HOLD_FLING_PX = 400;
const HOLD_FLING_MS = 800;
const HOLD_AFTER_END_MS = 1500;
const scr = { gen: false, held: false, touch: false, userAt: 0, liftAt: 0, top: 0, raf: 0, endTimer: 0 };

const chatEl = () => document.getElementById('chat');
const distBottom = el => el.scrollHeight - el.clientHeight - el.scrollTop;

function scrUser(e) {
    scr.userAt = Date.now();
    if (e.type === 'touchstart') scr.touch = true;
    if (e.type === 'touchend' || e.type === 'touchcancel') {
        scr.touch = false;
        scr.liftAt = scr.userAt;
    }
}

function onChatScroll() {
    const el = chatEl();
    if (!el) return;
    const now = Date.now();
    const d = distBottom(el);
    const byUser = scr.touch || now - scr.userAt < HOLD_FLING_MS;
    if (scr.held) {
        const limit = scr.touch ? Infinity : now - scr.liftAt < HOLD_FLING_MS ? HOLD_FLING_PX : HOLD_JUMP_PX;
        if (d < 2 && el.scrollTop - scr.top > limit) {
            el.scrollTop = scr.top;
            return jumpSoon();
        }
        if (d < 30 && byUser) scr.held = false;
    } else if (scr.gen && settings().holdScroll && d > HOLD_START_PX && byUser) scr.held = true;
    scr.top = el.scrollTop;
    jumpSoon();
}

function scrGenStart(dryRun) {
    if (dryRun) return;
    clearTimeout(scr.endTimer);
    scr.gen = true;
    scr.held = false;
}

function scrGenEnd() {
    scr.gen = false;
    clearTimeout(scr.endTimer);
    scr.endTimer = setTimeout(() => {
        scr.held = false;
        jumpRender();
    }, HOLD_AFTER_END_MS);
}

function jumpSoon() {
    if (scr.raf) return;
    scr.raf = requestAnimationFrame(() => {
        scr.raf = 0;
        jumpRender();
    });
}

function topFloor(el) {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 12)?.closest?.('#chat .mes');
    if (hit) return Number(hit.getAttribute('mesid'));
    const first = [...el.querySelectorAll('.mes')].find(m => m.getBoundingClientRect().bottom > r.top);
    return first ? Number(first.getAttribute('mesid')) : NaN;
}

function jumpRender() {
    const el = chatEl();
    const form = document.getElementById('send_form');
    if (!settings().jumpBar || !el || !form || $('#rs_overlay').length) return $('#rs_jump').remove();
    const far = distBottom(el) > el.clientHeight * JUMP_SHOW_SCREENS;
    if (!far && !scr.held) return $('#rs_jump').remove();
    let $j = $('#rs_jump');
    if (!$j.length) {
        $j = $(`<div id="rs_jump">
  <div class="rs_jump_b fa-solid fa-angles-up" data-j="top" title="跳到最上面"></div>
  <div class="rs_jump_n" data-j="go" title="跳到第几楼"></div>
  <div class="rs_jump_b fa-solid fa-angles-down" data-j="bottom" title="回到底部"></div>
</div>`).appendTo('body');
    }
    const id = topFloor(el);
    $j.find('.rs_jump_n').text(Number.isInteger(id) ? `第 ${id} 楼` : '跳楼层');
    $j.toggleClass('rs_held', scr.held && scr.gen);
    $j.css('bottom', `${Math.max(JUMP_GAP_PX, window.innerHeight - form.getBoundingClientRect().top + JUMP_GAP_PX)}px`);
}

function waitMore(el, before) {
    return new Promise(res => {
        const t0 = Date.now();
        const tick = () => {
            const first = Number(el.querySelector('.mes')?.getAttribute('mesid'));
            if (first !== before || Date.now() - t0 > JUMP_LOAD_WAIT_MS) return res(first !== before);
            setTimeout(tick, 50);
        };
        tick();
    });
}

async function jumpTo(id) {
    const c = ctx();
    const el = chatEl();
    if (!el || !c.chat.length) return;
    id = Math.max(0, Math.min(c.chat.length - 1, id));
    scr.held = false;
    let m = el.querySelector(`.mes[mesid="${id}"]`);
    while (!m) {
        const more = document.getElementById('show_more_messages');
        if (!more) break;
        const before = Number(el.querySelector('.mes')?.getAttribute('mesid'));
        $(more).trigger('click');
        if (!(await waitMore(el, before))) break;
        m = el.querySelector(`.mes[mesid="${id}"]`);
    }
    if (!m) return toastr.warning(`没找到第 ${id} 楼`);
    m.scrollIntoView({ block: 'start' });
    m.classList.add('rs_jump_hit');
    setTimeout(() => m.classList.remove('rs_jump_hit'), JUMP_FLASH_MS);
    scr.top = el.scrollTop;
    jumpRender();
}

async function jumpAct(a) {
    const el = chatEl();
    if (!el) return;
    if (a === 'bottom') {
        scr.held = false;
        el.scrollTop = el.scrollHeight;
        scr.top = el.scrollTop;
        return jumpRender();
    }
    if (a === 'top') return jumpTo(0);
    const n = ctx().chat.length;
    const cur = topFloor(el);
    const v = await askInput(`跳到第几楼（0–${n - 1}）`, Number.isInteger(cur) ? String(cur) : '');
    if (v === null || !String(v).trim()) return;
    const id = Number.parseInt(String(v).trim(), 10);
    if (!Number.isInteger(id)) return toastr.warning('填个数字');
    jumpTo(id);
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

const LOOK_RANGE = { panelWidth: [320, 1400], panelHeight: [50, 100], editFont: [12, 24], dim: [0, 90] };

function lookNum(k) {
    const [lo, hi] = LOOK_RANGE[k];
    const v = Number(settings()[k]);
    return Math.min(hi, Math.max(lo, Number.isFinite(v) && settings()[k] !== '' ? v : DEFAULTS[k]));
}

function applyLook() {
    const s = settings();
    const ov = document.getElementById('rs_overlay');
    const el = document.getElementById('rs_panel');
    if (!ov || !el) return;
    el.style.setProperty('--rs-w', lookNum('panelWidth') + 'px');
    el.style.setProperty('--rs-h', lookNum('panelHeight') + 'dvh');
    el.style.setProperty('--rs-font', lookNum('editFont') + 'px');
    ['accent', 'panelBg', 'panelText'].forEach(k => {
        const v = /^#[0-9a-f]{6}$/i.test(s[k]) ? s[k] : '';
        el.style.setProperty({ accent: '--rs-accent', panelBg: '--rs-bg', panelText: '--rs-text' }[k], v || null);
    });
    ov.style.background = `rgba(0, 0, 0, ${lookNum('dim') / 100})`;
    ov.classList.toggle('rs_center', lookNum('panelHeight') < 100);
    applySplitRatio();
}

const CC_PREVIEW = 40;
const cc = { list: [], sel: new Set(), badOnly: true, open: new Set() };

async function ccLoad() {
    const c = ctx();
    const kept = $('#rs_panel .rs_cc_list').length > 0;
    if (!kept) $('#rs_panel .rs_cc').html('<div class="rs_empty">正在读取……</div>');
    let data = [];
    try {
        const res = await apiPost('/api/chats/recent', { max: 100000 });
        if (!res?.ok) throw new Error(String(res?.status));
        data = await res.json();
    } catch (e) {
        console.error('[重生成拼接] 读取聊天文件失败', e);
        $('#rs_panel .rs_cc').html('<div class="rs_empty">读不到聊天文件</div>');
        return;
    }
    cc.list = (Array.isArray(data) ? data : []).map(x => {
        const ch = x.avatar && c.characters.find(y => y.avatar === x.avatar);
        const gr = x.group && (c.groups || []).find(g => g.id === x.group);
        const empty = !x.chat_items || /^\[The (chat|message) is empty\]$/.test(String(x.mes));
        const ok = x.group ? 'g:' + x.group : 'c:' + x.avatar;
        return {
            ...x,
            ok,
            key: `${ok}/${x.file_name}`,
            owner: ch?.name || gr?.name || String(x.avatar || x.group || '').replace(/\.png$/, ''),
            missing: !ch && !gr,
            bad: empty || (!ch && !gr),
        };
    }).sort((a, b) => b.bad - a.bad || a.owner.localeCompare(b.owner, 'zh'));
    cc.sel.clear();
    if (kept) ccRenderList();
    else ccRender();
}

function ccRender() {
    $('#rs_panel .rs_cc').html(`
<div class="rs_cc_bar">
  <span class="rs_cc_sum"></span>
  <span class="rs_chip rs_cc_bad${cc.badOnly ? ' rs_on' : ''}">只看有问题的</span>
</div>
<div class="rs_pz_filter"><input type="text" class="rs_cc_q" placeholder="搜索角色、聊天名或内容"></div>
<div class="rs_cc_list"></div>
<div class="rs_cc_bar">
  <span class="rs_chip rs_cc_all">全选</span>
  <div class="menu_button rs_cc_del"></div>
</div>`);
    ccRenderList();
}

function ccRows() {
    const q = String($('#rs_panel .rs_cc_q').val() || '').trim().toLowerCase();
    return cc.list.filter(x => (!cc.badOnly || x.bad)
        && (!q || [x.file_name, x.owner, x.mes].some(v => String(v || '').toLowerCase().includes(q))));
}

function ccRenderList() {
    const q = String($('#rs_panel .rs_cc_q').val() || '').trim();
    const rows = ccRows();
    const groups = new Map();
    rows.forEach(x => {
        if (!groups.has(x.ok)) groups.set(x.ok, []);
        groups.get(x.ok).push(x);
    });
    const owners = [...groups.keys()].map(k => ({ id: k, name: groups.get(k)[0].owner }));
    const labels = nameLabels(owners, null);
    const order = owners.sort((a, b) => groups.get(b.id).some(x => x.bad) - groups.get(a.id).some(x => x.bad) || a.name.localeCompare(b.name, 'zh'));
    const row = x => {
        const tags = [x.missing && '角色不存在', !x.missing && x.bad && '可能损坏'].filter(Boolean).map(t => `<span class="rs_pz_tag rs_pz_diff">${t}</span>`).join('');
        const pv = `${x.chat_items || 0} 条 · ${x.file_size || ''} · ${String(x.mes || '').replace(/\s+/g, ' ').slice(0, CC_PREVIEW)}`;
        return `<div class="rs_pz_row rs_cc_row${cc.sel.has(x.key) ? ' rs_pz_sel' : ''}" data-k="${escapeHtml(x.key)}"><span class="rs_cb_hit"><span class="rs_cb"></span></span><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(x.file_name.replace(/\.jsonl$/, ''))}</span>${tags}</div><div class="rs_pz_pv">${escapeHtml(pv)}</div></div></div>`;
    };
    const html = order.map(o => {
        const items = groups.get(o.id);
        const open = !!q || cc.open.has(o.id);
        const nb = items.filter(x => x.bad).length;
        const all = items.every(x => cc.sel.has(x.key));
        const some = items.some(x => cc.sel.has(x.key));
        return `<div class="rs_pz_row rs_pz_div rs_cc_head${all ? ' rs_pz_sel' : ''}" data-g="${escapeHtml(o.id)}"><span class="rs_cb_hit"><span class="rs_cb${some && !all ? ' rs_cb_part' : ''}"></span></span><span class="rs_pz_fold fa-solid ${open ? 'fa-chevron-down' : 'fa-chevron-right'}"></span><div class="rs_pz_main"><div class="rs_pz_name"><span class="rs_pz_nm">${escapeHtml(labels.get(o.id))}</span><span class="rs_pz_cnt">${items.length} 个</span>${nb && !cc.badOnly ? `<span class="rs_pz_tag rs_pz_diff">${nb} 个有问题</span>` : ''}</div></div></div>`
            + (open ? items.map(row).join('') : '');
    }).join('');
    $('#rs_panel .rs_cc_list').html(html || `<div class="rs_empty">${q ? '没有符合的聊天' : cc.badOnly ? '没有找到有问题的聊天文件' : '没有聊天文件'}</div>`);
    $('#rs_panel .rs_cc_sum').text(`共 ${cc.list.length} 个，可能有问题 ${cc.list.filter(x => x.bad).length} 个`);
    $('#rs_panel .rs_cc_bad').toggleClass('rs_on', cc.badOnly);
    $('#rs_panel .rs_cc_del').toggleClass('rs_off', !cc.sel.size).text(`删除选中（${cc.sel.size}）`);
}

function ccToggleGroup(g) {
    const items = ccRows().filter(x => x.ok === g);
    const all = items.every(x => cc.sel.has(x.key));
    items.forEach(x => (all ? cc.sel.delete(x.key) : cc.sel.add(x.key)));
}


function chatApi(op, x, chat) {
    const g = !!x.group;
    const url = `/api/chats/${g ? 'group/' : ''}${op}`;
    if (g) return apiPost(url, op === 'save' ? { id: x.file_id, chat, force: true } : { id: x.file_id });
    if (op === 'delete') return apiPost(url, { chatfile: `${x.file_id}.jsonl`, avatar_url: x.avatar });
    return apiPost(url, { ch_name: x.owner, file_name: x.file_id, avatar_url: x.avatar, ...(op === 'save' ? { chat, force: true } : {}) });
}

async function chatGet(x) {
    const r = await chatApi('get', x);
    return r?.ok ? await r.json().catch(() => null) : null;
}

async function ccRemove(x) {
    const body = await chatGet(x);
    if (Array.isArray(body) && body.length > 1) {
        if (!(await binAdd({ type: 'chat', label: x.file_id, sub: `${x.owner} · ${body.length - 1} 条`, data: { group: x.group || null, avatar: x.avatar || null, owner: x.owner, file_id: x.file_id, chat: body } }))) {
            toastr.error(`「${x.file_id}」没能备份进回收站，为了安全没有删`);
            return false;
        }
    }
    const first = await chatApi('delete', x);
    if (first?.ok) return true;
    const why = first ? await first.text().catch(() => '') : '';
    if (first?.status !== 404 && !/not\s*found/i.test(why)) return false;
    if (Array.isArray(body) && body.length) return false;
    const stub = [{ user_name: 'User', character_name: x.owner, create_date: Date.now(), chat_metadata: {} }];
    if (!(await chatApi('save', x, stub))?.ok) return false;
    return !!(await chatApi('delete', x))?.ok;
}

async function ccDelete() {
    const c = ctx();
    const cur = c.getCurrentChatId?.();
    const picks = cc.list.filter(x => cc.sel.has(x.key));
    const skip = picks.filter(x => x.file_id === cur);
    const go = picks.filter(x => x.file_id !== cur);
    if (skip.length) toastr.warning('正在打开的聊天不会删，先切到别的聊天');
    if (!go.length || !(await askConfirm(`删掉选中的 ${go.length} 个聊天文件？可以在回收站找回`))) return;
    let ok = 0;
    for (const x of go) {
        if (await ccRemove(x)) ok++;
    }
    toastr[ok === go.length ? 'success' : 'warning'](`删掉了 ${ok} 个${ok < go.length ? `，${go.length - ok} 个没删成` : ''}`);
    await ccLoad();
    if (!c.getCurrentChatId?.()) {
        try { await (await import('/scripts/welcome-screen.js')).openWelcomeScreen?.({ force: true }); } catch { }
    }
}

function renderSettings() {
    const s = settings();
    const color = (k, label) => `<div class="rs_set_color"><span>${label}</span><input type="color" data-look="${k}" value="${/^#[0-9a-f]{6}$/i.test(s[k]) ? s[k] : '#888888'}"><span class="rs_set_reset${s[k] ? '' : ' rs_on'}" data-reset="${k}">跟随主题</span></div>`;
    const range = (k, label, unit) => `<label class="rs_set_range"><span>${label}</span><input type="range" data-look="${k}" min="${LOOK_RANGE[k][0]}" max="${LOOK_RANGE[k][1]}" value="${lookNum(k)}"><b>${lookNum(k)}${unit}</b></label>`;
    $('#rs_panel .rs_set').html(`
<div class="rs_set_body">
      <div class="rs_set_h">外观</div>
      ${range('panelWidth', '面板宽度', 'px')}
      ${range('panelHeight', '面板高度', '%')}
      ${range('editFont', '编辑区字号', 'px')}
      ${range('dim', '背景变暗', '%')}
      ${color('accent', '强调色')}
      ${color('panelBg', '面板底色')}
      ${color('panelText', '文字颜色')}
      <div class="rs_set_h">悬浮球</div>
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
      <div class="rs_set_h">聊天</div>
      <label class="checkbox_label"><input type="checkbox" id="rs_enabled"> 重新生成时保留旧版本</label>
      <label>每条消息最多保留版本数<input type="number" id="rs_max" class="text_pole" min="2"></label>
      <label class="checkbox_label"><input type="checkbox" id="rs_tap_on"> 双击聊天里的段落直接编辑</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_selguard_on"> 聊天里选字只选在同一楼（防止乱跳、选太多）</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_vchip_on"> 有多个版本的楼层显示版本切换</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_bchip_on"> 有分支的楼层显示分支切换</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_jump_on"> 往上翻时显示楼层跳转（最上 / 第几楼 / 最下）</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_hold_on"> 生成时往上翻，不把我拉回底部</label>
      <div class="rs_set_h">编辑</div>
      <label class="checkbox_label"><input type="checkbox" id="rs_cliche_on"> 楼层编辑时标出八股词</label>
      <label class="checkbox_label"><input type="checkbox" id="rs_cliche_whole"> 八股词整句标出</label>
      <label>八股词表（一行一个；中间隔字用 ……，比如 不是……而是；用 /.../ 包起来是正则）
        <textarea id="rs_cliche_words" class="text_pole" rows="6"></textarea>
      </label>
      <label>正文标签（“只编辑正文”时只留这个标签里的内容，比如 content）<input type="text" id="rs_body_tag" class="text_pole"></label>
      <label>每一项最多留存的存档数<input type="number" id="rs_snap_keep" class="text_pole" min="2"></label>
      <div class="rs_set_h">预设缝合</div>
      <label>分类标题的写法（一行一种；条目名里有这段字就当成分类，比如 ‖ 或 【分类】；用 /.../ 包起来是正则，比如 /^┌.*┐$/）。━━、═══、☆☆ 这种连着的符号不用写，本来就能认出来
        <textarea id="rs_pz_divs" class="text_pole" rows="4" placeholder="‖&#10;/^┌.*┐$/"></textarea>
      </label>
      <div class="rs_set_note rs_pz_divs_n"></div>
      <div class="rs_set_h">聊天文件</div>
      <div class="rs_set_note">迁移后坏掉、只在欢迎页显示的聊天，可以在这里找出来删掉</div>
      <div class="menu_button rs_cc_load">检查聊天文件</div>
      <div class="rs_cc"></div>
</div>`);

    $('#rs_panel .rs_set input[data-look]').on('input', function () {
        const k = this.dataset.look;
        settings()[k] = this.type === 'color' ? this.value : Number(this.value);
        if (this.type === 'range') $(this).next('b').text(this.value + (k === 'panelWidth' || k === 'editFont' ? 'px' : '%'));
        else $(this).nextAll('.rs_set_reset').removeClass('rs_on');
        applyLook();
        ctx().saveSettingsDebounced();
    });
    $('#rs_panel .rs_set .rs_set_reset').on('click', function () {
        settings()[this.dataset.reset] = '';
        $(this).addClass('rs_on');
        applyLook();
        ctx().saveSettingsDebounced();
    });
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
    $('#rs_jump_on').prop('checked', s.jumpBar).on('change', function () {
        settings().jumpBar = this.checked;
        ctx().saveSettingsDebounced();
        jumpRender();
    });
    $('#rs_hold_on').prop('checked', s.holdScroll).on('change', function () {
        settings().holdScroll = this.checked;
        ctx().saveSettingsDebounced();
        if (!this.checked) scr.held = false;
    });
    const divCount = () => {
        const live = ctx().getPresetManager?.('openai')?.getPresetList?.()?.settings;
        const cats = pzFromPreset({ prompts: live?.prompts || [], prompt_order: live?.prompt_order || [] }).filter(e => e.div).map(e => pzCatName(e.name) || e.name.trim());
        $('#rs_panel .rs_pz_divs_n').text(cats.length ? `当前预设认出 ${cats.length} 个分类：${cats.slice(0, 12).join('、')}${cats.length > 12 ? '…' : ''}` : '当前预设没认出分类');
    };
    $('#rs_pz_divs').val(s.pzDividers).on('input', function () {
        settings().pzDividers = this.value;
        ctx().saveSettingsDebounced();
        if (pz.src?.entries) pzClassify(pz.src.entries);
        divCount();
    });
    divCount();
    $('#rs_cliche_on').prop('checked', s.clicheOn).on('change', function () { setClicheSetting('clicheOn', this.checked); });
    $('#rs_cliche_whole').prop('checked', s.clicheWhole).on('change', function () { setClicheSetting('clicheWhole', this.checked); });
    $('#rs_cliche_words').val(s.clicheWords).on('input', function () { setClicheSetting('clicheWords', this.value); });
    $('#rs_body_tag').val(s.readerBody).on('input', function () {
        settings().readerBody = this.value.trim();
        ctx().saveSettingsDebounced();
    });
    $('#rs_panel .rs_cc_load').on('click', ccLoad);
    $('#rs_panel .rs_cc').on('click', '.rs_cc_row', function () {
        const k = this.dataset.k;
        flip(cc.sel, k);
        ccRenderList();
    }).on('click', '.rs_cc_head', function (e) {
        const g = this.dataset.g;
        if ($(e.target).closest('.rs_cb_hit').length) ccToggleGroup(g);
        else flip(cc.open, g);
        ccRenderList();
    }).on('input', '.rs_cc_q', ccRenderList).on('click', '.rs_cc_bad', () => {
        cc.badOnly = !cc.badOnly;
        ccRenderList();
    }).on('click', '.rs_cc_all', () => {
        const rows = ccRows();
        const all = rows.length && rows.every(x => cc.sel.has(x.key));
        rows.forEach(x => (all ? cc.sel.delete(x.key) : cc.sel.add(x.key)));
        ccRenderList();
    }).on('click', '.rs_cc_del', ccDelete);
    $('#rs_snap_keep').val(s.snapKeep).on('input', function () {
        settings().snapKeep = Math.max(2, parseInt(this.value) || DEFAULTS.snapKeep);
        ctx().saveSettingsDebounced();
    });
}

jQuery(() => {
    const c = ctx();
    const ev = c.eventTypes || c.event_types;

    injectButtons();
    bindPanelEvents();
    renderBall();
    document.addEventListener('selectionchange', guardSelection);
    const chatBox = chatEl();
    if (chatBox) {
        chatBox.addEventListener('scroll', onChatScroll, { passive: true });
        ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel', 'pointerdown', 'keydown']
            .forEach(t => chatBox.addEventListener(t, scrUser, { passive: true }));
    }
    $(document).on('click', '#rs_jump [data-j]', function () { jumpAct(this.dataset.j); });
    window.visualViewport?.addEventListener('resize', jumpSoon);
    window.visualViewport?.addEventListener('resize', () => { if (tap) keepInView(); });
    addWandMenu();
    setTimeout(addWandMenu, 1500);
    window.addEventListener('resize', () => {
        const el = document.getElementById('rs_ball');
        if (el) placeBall(el.offsetLeft, el.offsetTop);
    });

    c.eventSource.on(ev.GENERATION_STARTED, onGenStarted);
    c.eventSource.on(ev.GENERATION_STARTED, (_t, _o, dryRun) => scrGenStart(dryRun));
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
    c.eventSource.on(ev.GENERATION_ENDED, scrGenEnd);
    c.eventSource.on(ev.GENERATION_STOPPED, scrGenEnd);
    c.eventSource.on(ev.CHAT_CHANGED, () => {
        pending = null;
        scr.held = false;
        setTimeout(jumpRender, 300);
        injectButtons();
        if (state.target?.kind === 'msg') {
            closePanel(true, true);
            toastr.info('切换了聊天，楼层编辑面板已关闭');
        }
    });
});
