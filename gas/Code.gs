// おてつだい ちょきん（GAS）。build.py が src/core.js と src/gas.js から作ったファイル。直すときは src の方を直す

/* おてつだい ちょきん：きまり（ルール）
 * アプリ（試作のダミー）と GAS（本番）の両方で、この同じファイルを使う。
 * build.py が index.html と gas/Code.gs に書き写すので、直すのはここだけ。
 * GAS でも動くように、?? や ?. は使わない。
 *
 * st（全部のデータ）の形
 *   names:    {k1:'上の子', k2:'下の子'}
 *   chores:   [{id, name, yen, deleted}]
 *   records:  [{id, kid, type:'chore'|'withdraw', name, yen, tip, status, at, doneAt, qid, req}]
 *             status: pending（OK待ち）/ approved（OK・渡した）/ redo（やり直し）/ rejected（引き出しをやめた）/ cancelled（子どもが取り消した）
 *   requests: [{id, name, yen, mode:'shimei'|'hayai', to, status, at}]
 *             status: open / taken（早い者勝ちで「やる！」が押された）/ submitted（やったよ）/ done / cancelled
 *   wallet:   [{id, kid, type:'in'|'out', cat, memo, yen, at, deleted}]   おさいふ（手元のお金）。子どもが自分で書く
 *             in＝もらった（お年玉など）/ out＝つかった。ママが「渡した」引き出しは records から数える（ここには書かない）
 * 書きかえた物には _dirty、新しく足した物には _new の印をつける（GAS はこの印を見てシートに書く）
 */
var CORE = (function () {
  var MAX_YEN = 100000;          // 1回の金額・チップ・引き出しの上限
  var NAME_MAX = 10;             // 子どもの呼び名
  var CHORE_MAX = 20;            // お手伝いの名前
  var MEMO_MAX = 20;             // おさいふの「ひとこと」
  var CATS = ['おかし', 'おもちゃ', 'ほん', 'あそび', 'プレゼント', 'そのほか'];   // つかった ときの使いみち
  var KIDS = ['k1', 'k2'];

  // 全角の数字も読む。数字以外がまざっていたら bad
  function toInt(v) {
    var t = String(v == null ? '' : v).trim()
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[,，円]/g, '');
    if (t === '') return { n: 0, empty: true };
    if (!/^[0-9]+$/.test(t)) return { n: 0, bad: true };
    return { n: parseInt(t, 10) };
  }
  // 文字の掃除：制御文字を消して前後の空白を取り、max 文字で切る
  function cleanText(s, max) {
    var t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/^'+/, '').trim();   // 先頭の ' はシートが消すので最初から取る
    return Array.from(t).slice(0, max).join('');
  }
  function balance(st, kid) {
    return st.records.filter(function (r) { return r.kid === kid && r.status === 'approved'; })
      .reduce(function (s, r) { return s + (r.type === 'withdraw' ? -r.yen : r.yen + (r.tip || 0)); }, 0);
  }
  function waitingWithdraw(st, kid) {
    return st.records.filter(function (r) { return r.kid === kid && r.type === 'withdraw' && r.status === 'pending'; })
      .reduce(function (s, r) { return s + r.yen; }, 0);
  }
  // おさいふの のこり＝ママが渡した引き出し＋もらった−つかった
  function walletBalance(st, kid) {
    var got = st.records.filter(function (r) { return r.kid === kid && r.type === 'withdraw' && r.status === 'approved'; })
      .reduce(function (s, r) { return s + r.yen; }, 0);
    return (st.wallet || []).filter(function (w) { return w.kid === kid && !w.deleted; })
      .reduce(function (s, w) { return s + (w.type === 'out' ? -w.yen : w.yen); }, got);
  }
  // おさいふの きろくを古い順に足したときの、途中の いちばん少ない のこり（0より上なら0）。skip のIDの1件は数えない
  // 前の日の「もらった」を消すと、最後の のこりはプラスでも途中がマイナスになることがあるので、消す前にこれで確かめる
  function walletLowest(st, kid, skip) {
    var rows = st.records.filter(function (r) { return r.kid === kid && r.type === 'withdraw' && r.status === 'approved'; })
      .map(function (r) { return { at: r.doneAt || r.at, v: r.yen }; })
      .concat((st.wallet || []).filter(function (w) { return w.kid === kid && !w.deleted && w.id !== skip; })
        .map(function (w) { return { at: w.at, v: w.type === 'out' ? -w.yen : w.yen }; }));
    rows.sort(function (a, b) { return a.at - b.at; });
    var run = 0, low = 0;
    rows.forEach(function (x) { run += x.v; if (run < low) low = run; });
    return low;
  }
  // その「もらった」を消すと、おさいふの きろくの どこかで のこりがマイナスになる（今より悪くなる）か
  function walletDelBreaks(st, kid, w) {
    return w.type === 'in' && walletLowest(st, kid, w.id) < walletLowest(st, kid, null);
  }
  function fail(code, extra) {
    var e = new Error(code);
    e.code = code;
    e.extra = extra || null;
    throw e;
  }

  // 1つの操作をする。だめなら fail(理由) で止める（データはそのまま）
  function apply(st, role, a, p, now, newId) {
    p = p || {};
    var isKid = KIDS.indexOf(role) >= 0;
    var isMama = role === 'mama';
    function kidOnly() { if (!isKid) fail('perm'); }
    function mamaOnly() { if (!isMama) fail('perm'); }
    function rec(id) { return st.records.filter(function (r) { return r.id === String(id); })[0]; }
    function req(id) { return st.requests.filter(function (q) { return q.id === String(id); })[0]; }
    function chore(id) { return st.chores.filter(function (c) { return c.id === String(id) && !c.deleted; })[0]; }
    function touch(o) { o._dirty = true; return o; }
    function add(list, o) { o._new = true; list.push(o); return o; }
    var r, q, c, t;

    switch (a) {
      case 'load':
        return {};

      /* ----- 子ども ----- */
      case 'done':          // お手伝い一覧から「やったよ」
        kidOnly();
        c = chore(p.cid); if (!c) fail('gone');
        add(st.records, { id: newId(), kid: role, type: 'chore', name: c.name, yen: c.yen, tip: 0, status: 'pending', at: now, doneAt: null, qid: '', req: false });
        return {};
      case 'withdraw':      // 引き出したい
        kidOnly();
        t = toInt(p.yen);
        if (t.bad || t.empty || t.n <= 0 || t.n > MAX_YEN) fail('input');
        var can = balance(st, role) - waitingWithdraw(st, role);
        if (t.n > can) fail('balance', { can: can });
        add(st.records, { id: newId(), kid: role, type: 'withdraw', name: '', yen: t.n, tip: 0, status: 'pending', at: now, doneAt: null, qid: '', req: false });
        return {};
      case 'take':          // 早い者勝ちの「やる！」
        kidOnly();
        q = req(p.qid);
        if (!q || q.mode !== 'hayai' || q.status === 'cancelled' || q.status === 'done') fail('gone');
        if (q.status !== 'open') fail(q.to === role ? 'gone' : 'taken');
        q.status = 'taken'; q.to = role; touch(q);
        return {};
      case 'untake':        // 「やる！」の取り消し → 2人に出した状態に戻す
        kidOnly();
        q = req(p.qid);
        if (!q || q.status !== 'taken' || q.to !== role) fail('gone');
        q.status = 'open'; q.to = ''; touch(q);
        return {};
      case 'reqdone':       // 付箋の「やったよ」
        kidOnly();
        q = req(p.qid);
        var mine = q && ((q.status === 'open' && q.mode === 'shimei' && q.to === role) || (q.status === 'taken' && q.to === role));
        if (!mine) fail(q && q.status === 'taken' ? 'taken' : 'gone');
        q.status = 'submitted'; q.to = role; touch(q);
        add(st.records, { id: newId(), kid: role, type: 'chore', name: q.name, yen: q.yen, tip: 0, status: 'pending', at: now, doneAt: null, qid: q.id, req: true });
        return {};
      case 'again':         // やり直しのあと「もういちど やったよ」
        kidOnly();
        r = rec(p.rid);
        if (!r || r.kid !== role || r.status !== 'redo') fail('gone');
        r.status = 'pending'; r.at = now; touch(r);
        return {};
      case 'cancel':        // OKまちの「とりけす」
        kidOnly();
        r = rec(p.rid);
        if (!r || r.kid !== role || (r.status !== 'pending' && r.status !== 'redo')) fail('gone');
        r.status = 'cancelled'; touch(r);
        if (r.qid) {
          q = req(r.qid);
          if (q && q.status === 'submitted') { q.status = q.mode === 'hayai' ? 'taken' : 'open'; touch(q); }
        }
        return {};
      case 'saifu_in':      // おさいふ：もらった（お年玉・おばあちゃんから など）
      case 'saifu_out':     // おさいふ：つかった（のこりより多くは書けない）
        kidOnly();
        t = toInt(p.yen);
        if (t.bad || t.empty || t.n <= 0 || t.n > MAX_YEN) fail('input');
        var out = a === 'saifu_out';
        if (out && CATS.indexOf(String(p.cat)) < 0) fail('input');
        if (out && t.n > walletBalance(st, role)) fail('saifu', { can: walletBalance(st, role) });
        if (!st.wallet) st.wallet = [];
        add(st.wallet, { id: newId(), kid: role, type: out ? 'out' : 'in', cat: out ? String(p.cat) : '', memo: cleanText(p.memo, MEMO_MAX), yen: t.n, at: now, deleted: false });
        return {};
      case 'saifu_del':     // おさいふ：書きまちがいを消す（印をつけるだけ）
        kidOnly();
        var w = (st.wallet || []).filter(function (x) { return x.id === String(p.wid) && x.kid === role && !x.deleted; })[0];
        if (!w) fail('gone');
        if (walletDelBreaks(st, role, w)) fail('saifu_del');   // 消すと きろくの途中で のこりがマイナスになる
        w.deleted = true; touch(w);
        return {};

      /* ----- ママ ----- */
      case 'ok':            // OK（チップつき）
        mamaOnly();
        r = rec(p.rid);
        if (!r || r.type !== 'chore' || r.status !== 'pending') fail('gone');
        t = toInt(p.tip);
        if (t.bad || t.n > MAX_YEN) fail('input');
        r.status = 'approved'; r.tip = t.n; r.doneAt = now; touch(r);
        if (r.qid) { q = req(r.qid); if (q) { q.status = 'done'; touch(q); } }
        return {};
      case 'redo':          // やり直し
        mamaOnly();
        r = rec(p.rid);
        if (!r || r.type !== 'chore' || r.status !== 'pending') fail('gone');
        r.status = 'redo'; touch(r);
        return {};
      case 'wok':           // 引き出し：渡した
        mamaOnly();
        r = rec(p.rid);
        if (!r || r.type !== 'withdraw' || r.status !== 'pending') fail('gone');
        if (balance(st, r.kid) < r.yen) fail('balance', { can: balance(st, r.kid) });
        r.status = 'approved'; r.doneAt = now; touch(r);
        return {};
      case 'wno':           // 引き出し：やめる
        mamaOnly();
        r = rec(p.rid);
        if (!r || r.type !== 'withdraw' || r.status !== 'pending') fail('gone');
        r.status = 'rejected'; r.doneAt = now; touch(r);
        return {};
      case 'ask':           // お願いを書く
        mamaOnly();
        c = chore(p.cid); if (!c) fail('gone');
        if (p.who !== 'k1' && p.who !== 'k2' && p.who !== 'both') fail('input');
        add(st.requests, { id: newId(), name: c.name, yen: c.yen, mode: p.who === 'both' ? 'hayai' : 'shimei', to: p.who === 'both' ? '' : p.who, status: 'open', at: now });
        return {};
      case 'reqcancel':     // お願いの取り消し
        mamaOnly();
        q = req(p.qid);
        if (!q || (q.status !== 'open' && q.status !== 'taken')) fail('gone');
        q.status = 'cancelled'; touch(q);
        return {};
      case 'chore_add':
        mamaOnly();
        var nm = cleanText(p.name, CHORE_MAX) || '新しいお手伝い';
        t = toInt(p.yen == null ? 10 : p.yen);
        if (t.bad || t.empty || t.n > MAX_YEN) fail('input');
        add(st.chores, { id: newId(), name: nm, yen: t.n, deleted: false });
        return {};
      case 'chore_edit':
        mamaOnly();
        c = chore(p.cid); if (!c) fail('gone');
        var n2 = c.name, y2 = c.yen;      // 両方確かめてから書きかえる（だめなら何も変えない）
        if (p.name != null) { n2 = cleanText(p.name, CHORE_MAX); if (!n2) fail('input'); }
        if (p.yen != null) { t = toInt(p.yen); if (t.bad || t.empty || t.n > MAX_YEN) fail('input'); y2 = t.n; }
        c.name = n2; c.yen = y2; touch(c);
        return {};
      case 'chore_del':     // 消しても過去の記録は残る（印をつけるだけ）
        mamaOnly();
        c = chore(p.cid); if (!c) fail('gone');
        c.deleted = true; touch(c);
        return {};
      case 'names':
        mamaOnly();
        var k1 = cleanText(p.k1, NAME_MAX), k2 = cleanText(p.k2, NAME_MAX);
        if (!k1 || !k2) fail('input');
        if (k1 === k2) fail('same');
        st.names = { k1: k1, k2: k2 }; st._namesDirty = true;
        return {};
    }
    fail('action');
  }

  // その人に見せてよい分だけを返す（子どもには自分の記録だけ）
  function strip(o) { var x = {}; for (var k in o) { if (k.charAt(0) !== '_') x[k] = o[k]; } return x; }
  function view(st, role) {
    var isKid = KIDS.indexOf(role) >= 0;
    var out = { role: role, names: { k1: st.names.k1, k2: st.names.k2 } };
    out.chores = st.chores.filter(function (c) { return !c.deleted; }).map(strip);
    out.wallet = (st.wallet || []).filter(function (w) { return !w.deleted && (!isKid || w.kid === role); }).map(strip);
    if (isKid) {
      out.records = st.records.filter(function (r) { return r.kid === role && r.status !== 'cancelled'; }).map(strip);
      out.requests = st.requests.filter(function (q) {
        return (q.status === 'open' && (q.mode === 'hayai' || q.to === role)) || (q.status === 'taken' && q.to === role);
      }).map(strip);
    } else {
      out.records = st.records.filter(function (r) { return r.status !== 'cancelled'; }).map(strip);
      out.requests = st.requests.filter(function (q) { return q.status === 'open' || q.status === 'taken' || q.status === 'submitted'; }).map(strip);
    }
    return out;
  }

  return { apply: apply, view: view, balance: balance, waitingWithdraw: waitingWithdraw, walletBalance: walletBalance, walletDelBreaks: walletDelBreaks, toInt: toInt, cleanText: cleanText,
    MAX_YEN: MAX_YEN, NAME_MAX: NAME_MAX, CHORE_MAX: CHORE_MAX, MEMO_MAX: MEMO_MAX, CATS: CATS };
})();

/* ===== ここから GAS：スプレッドシートの読み書き ===== */
/* 使い方（最初の1回だけ）
 *   0. 個人の Gmail で作る。ほかのアカウントと混ざらないよう、シークレットウィンドウ（Cmd+Shift+N）でその1つだけログインして作業する
 *   1. script.google.com →「新しいプロジェクト」（スプレッドシートの「拡張機能 → Apps Script」からでもよい）を開き、
 *      最初からある myFunction を消して、gas/Code.gs の中身を全部貼って保存（src/gas.js だけを貼ると、きまり＝CORE が無くて動かない）
 *   2. 上の関数の選択で setup を選んで「実行」（データ用のスプレッドシートと表と合言葉ができる。
 *      Apps Script だけで作ったときは「おてつだい ちょきん（データ）」というスプレッドシートを自動で作る。場所は実行ログに出る）
 *      最初だけ承認の画面が続く：権限を確認 → アカウントを選ぶ → 「このアプリは Google で確認されていません」→ 詳細 →
 *      （プロジェクト名）に移動 → チェック欄は全部オン → 許可
 *   3. 「デプロイ → 新しいデプロイ → 種類の選択：ウェブアプリ」
 *        次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員（「Google アカウントを持つ全員」ではない。選び違えるとつながらない）
 *   4. 出てきた /exec で終わるURLをブラウザで開き、{"ok":true,"app":"otetsudai"} と出ればOK。このURLをアプリ（index.html の GAS_URL）に入れる
 * コードを直したときは「デプロイを管理 → 鉛筆 → バージョン：新バージョン → デプロイ」（URLは変わらない。新しいデプロイは作らない）
 * 表が増えたとき（2026-10 の「おさいふ」など）は、貼り直したあと setup をもう一度実行する（今のデータは消えない）
 */
var APP_URL = 'https://asami009.github.io/otetsudai/';   // アプリの置き場所

var SH = { settings: '設定', chores: 'お手伝い', records: '記録', requests: 'お願い', urls: '配るURL', wallet: 'おさいふ' };
var COLS = {
  chores: [['id', 'ID'], ['name', 'お手伝い'], ['yen', '金額'], ['deleted', '消した']],
  records: [['id', 'ID'], ['kid', '子ども'], ['type', '種類'], ['name', 'お手伝い'], ['yen', '金額'], ['tip', 'チップ'], ['status', '状態'],
    ['at', '申請した日時'], ['doneAt', '確定した日時'], ['qid', 'お願いID'], ['req', 'お願いから']],
  requests: [['id', 'ID'], ['name', 'お手伝い'], ['yen', '金額'], ['mode', '頼み方'], ['to', '相手'], ['status', '状態'], ['at', '頼んだ日時']],
  wallet: [['id', 'ID'], ['kid', '子ども'], ['type', '種類'], ['cat', '使いみち'], ['memo', 'ひとこと'], ['yen', '金額'], ['at', '書いた日時'], ['deleted', '消した']]
};
var KIND_OF = { id: 'text', name: 'text', kid: 'text', type: 'text', status: 'text', qid: 'text', mode: 'text', to: 'text', cat: 'text', memo: 'text',
  yen: 'num', tip: 'num', at: 'time', doneAt: 'time', deleted: 'bool', req: 'bool' };
var SAMPLE_CHORES = [['しょっき あらい', 30], ['せんたくものを たたむ', 50], ['おふろ そうじ', 40], ['ゴミだし', 20], ['くつを そろえる', 10], ['へやの そうじき', 50]];

/* ----- 受付（アプリから呼ばれる） ----- */
function doGet() {
  return json_({ ok: true, app: 'otetsudai' });
}
function doPost(e) {
  var out;
  try {
    var p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = handle_(p);
  } catch (err) {
    out = { ok: false, err: 'server', msg: String((err && err.message) || err) };
  }
  return json_(out);
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(p) {
  var ss = open_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: false, err: 'busy' };   // 2人が同時に押しても1人ずつ順番に（アプリが待つ20秒より早く返す）
  try {
    var stg = readSettings_(ss);
    var role = roleOf_(stg, p.k);
    if (!role) return { ok: false, err: 'key' };
    var a = String(p.a || 'load');
    var st = load_(ss, stg);
    var res = { ok: true };
    if (a !== 'load') {
      try {
        CORE.apply(st, role, a, p, Date.now(), newId_);
      } catch (err) {
        if (err && err.code) res = { ok: false, err: err.code, extra: err.extra || null };
        else throw err;
      }
      if (res.ok) save_(ss, st);
    }
    res.state = CORE.view(st, role);
    if (role === 'mama') {
      res.state.keys = { k1: stg.key_k1, k2: stg.key_k2, mama: stg.key_mama };
      res.state.appUrl = APP_URL;
    }
    return res;
  } finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }   // 書き込みを確定させてから次の人に回す（公式の決まり）
  }
}

function roleOf_(stg, k) {
  k = String(k || '');
  if (k.length < 16) return null;
  if (k === stg.key_mama) return 'mama';
  if (k === stg.key_k1) return 'k1';
  if (k === stg.key_k2) return 'k2';
  return null;
}
function open_() {
  var id = PropertiesService.getScriptProperties().getProperty('SSID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}
function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}
function newKey_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 24);
}

/* ----- シートの読み書き ----- */
// 「=」「+」「-」「@」で始まる文字は、シートが計算式だと思わないように ' を前につける
function txt_(s) {
  s = String(s == null ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function untxt_(v) {
  var s = String(v == null ? '' : v);
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}
function toCell_(key, v) {
  var k = KIND_OF[key];
  if (k === 'time') return v ? new Date(v) : '';
  if (k === 'bool') return !!v;
  if (k === 'num') return Number(v) || 0;
  return txt_(v);
}
function fromCell_(key, v) {
  var k = KIND_OF[key];
  if (k === 'time') {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    return v ? (new Date(v)).getTime() || null : null;
  }
  if (k === 'bool') return v === true || String(v).toUpperCase() === 'TRUE';
  if (k === 'num') return Number(v) || 0;
  return untxt_(v);
}
function readTable_(ss, kind) {
  var sh = ss.getSheetByName(SH[kind]);
  if (!sh) return [];                       // まだ表が無い（コードを新しくして setup をまだ実行していない）
  var cols = COLS[kind];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var rows = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var out = [];
  rows.forEach(function (row, i) {
    if (row[0] === '' || row[0] == null) return;   // 空の行は飛ばす
    var o = { _row: i + 2 };
    cols.forEach(function (c, j) { o[c[0]] = fromCell_(c[0], row[j]); });
    out.push(o);
  });
  return out;
}
function writeTable_(ss, kind, list) {
  if (!list.some(function (o) { return o._new || (o._dirty && o._row); })) return;
  var sh = table_(ss, kind);
  var cols = COLS[kind];
  var toRow = function (o) { return cols.map(function (c) { return toCell_(c[0], o[c[0]]); }); };
  list.forEach(function (o) {
    if (o._dirty && !o._new && o._row) sh.getRange(o._row, 1, 1, cols.length).setValues([toRow(o)]);
  });
  var adds = list.filter(function (o) { return o._new; }).map(toRow);
  if (!adds.length) return;
  var start = sh.getLastRow() + 1, need = start + adds.length - 1, max = sh.getMaxRows();
  if (need > max) {                       // 行が足りなければ足す（新しいシートは1000行しかない）
    var more = Math.max(need - max, 500);
    sh.insertRowsAfter(max, more);
    formatRows_(sh, kind, max + 1, more);
  }
  sh.getRange(start, 1, adds.length, cols.length).setValues(adds);
}
// 表を出す。無ければ見出しと書式つきで作る（setup をし忘れても書ける）
function table_(ss, kind) {
  var sh = ss.getSheetByName(SH[kind]);
  if (sh) return sh;
  sh = sheet_(ss, SH[kind], COLS[kind].map(function (c) { return c[1]; }));
  formatRows_(sh, kind, 2, sh.getMaxRows() - 1);
  return sh;
}
// 文字の列は「書式なしテキスト」、日時の列は日時の形にする
function formatRows_(sh, kind, row, n) {
  COLS[kind].forEach(function (c, j) {
    var col = sh.getRange(row, j + 1, n, 1);
    if (KIND_OF[c[0]] === 'text') col.setNumberFormat('@');
    if (KIND_OF[c[0]] === 'time') col.setNumberFormat('yyyy/mm/dd hh:mm:ss');
  });
}
function load_(ss, stg) {
  return {
    names: { k1: stg.name_k1 || '上の子', k2: stg.name_k2 || '下の子' },
    chores: readTable_(ss, 'chores'),
    records: readTable_(ss, 'records'),
    requests: readTable_(ss, 'requests'),
    wallet: readTable_(ss, 'wallet')
  };
}
function save_(ss, st) {
  writeTable_(ss, 'chores', st.chores);
  writeTable_(ss, 'records', st.records);
  writeTable_(ss, 'requests', st.requests);
  writeTable_(ss, 'wallet', st.wallet || []);
  if (st._namesDirty) {
    writeSetting_(ss, 'name_k1', st.names.k1);
    writeSetting_(ss, 'name_k2', st.names.k2);
    writeUrls_(ss);                       // 「配るURL」の名前もそろえる
  }
}

/* ----- 設定（名前と合言葉） ----- */
function readSettings_(ss) {
  var sh = ss.getSheetByName(SH.settings);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    if (r[0] && !(String(r[0]) in out)) out[String(r[0])] = untxt_(r[1]);   // 同じ項目が2行あっても最初の行を使う（書くのも最初の行）
  });
  return out;
}
function writeSetting_(ss, id, value) {
  var sh = ss.getSheetByName(SH.settings);
  var last = sh.getLastRow();
  var ids = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  var i = ids.indexOf(id);
  if (i >= 0) sh.getRange(i + 2, 2).setValue(txt_(value));
  else sh.appendRow([id, txt_(value), '']);
}

/* ----- 最初の1回：表と合言葉を作る（もう一度実行しても、合言葉や記録は消えない） ----- */
function setup() {
  var ss = setupSs_();

  var st = sheet_(ss, SH.settings, ['項目', '値', '説明']);
  st.getRange('A:B').setNumberFormat('@');
  var cur = readSettings_(ss);
  [['name_k1', '上の子', '1人目の呼び名（アプリのママの画面から変えられる）'],
    ['name_k2', '下の子', '2人目の呼び名'],
    ['key_k1', '', '1人目の合言葉。URLに入る。人に見せない'],
    ['key_k2', '', '2人目の合言葉'],
    ['key_mama', '', 'ママの合言葉。これを知っている人はママの画面を開ける']
  ].forEach(function (d) {
    if (cur[d[0]]) return;                // もう値があれば触らない
    var v = d[0].indexOf('key_') === 0 ? newKey_() : d[1];
    if (d[0] in cur) writeSetting_(ss, d[0], v);   // 行はあるのに値が空なら、その行に入れる
    else st.appendRow([d[0], v, d[2]]);
  });

  ['chores', 'records', 'requests', 'wallet'].forEach(function (kind) {
    var sh = sheet_(ss, SH[kind], COLS[kind].map(function (c) { return c[1]; }));
    formatRows_(sh, kind, 2, sh.getMaxRows() - 1);
  });

  var ch = ss.getSheetByName(SH.chores);
  if (ch.getLastRow() < 2) {
    ch.getRange(2, 1, SAMPLE_CHORES.length, 4).setValues(SAMPLE_CHORES.map(function (c) { return [newId_(), c[0], c[1], false]; }));
  }
  writeUrls_(ss);
  var s1 = ss.getSheetByName('シート1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  Logger.log('できました。スプレッドシート「' + ss.getName() + '」の「' + SH.urls + '」の表にママ用のURLがあります → ' + ss.getUrl());
}
// データを置くスプレッドシート：前に作った物 → スプレッドシートから開いたときはそれ → どちらも無ければ新しく作る
function setupSs_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SSID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* 消されていたら作り直す */ } }
  var ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create('おてつだい ちょきん（データ）');
  props.setProperty('SSID', ss.getId());
  return ss;
}

// ★合言葉が人に知られたときだけ実行する：3人ぶん作り直す。古いURL（ホーム画面のアイコン）は全部使えなくなり、QRの配り直しになる
function 合言葉を全部作り直す_URLが変わる() {
  var ss = open_();
  ['key_k1', 'key_k2', 'key_mama'].forEach(function (id) { writeSetting_(ss, id, newKey_()); });
  writeUrls_(ss);
  Logger.log('合言葉を作り直しました。「' + SH.urls + '」の新しいURLで開き直してください');
}

function writeUrls_(ss) {
  var stg = readSettings_(ss);
  var sh = sheet_(ss, SH.urls, ['だれの', 'URL']);
  sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).clearContent();
  sh.getRange(2, 1, 3, 2).setNumberFormat('@').setValues([
    ['ママ（最初にこれを開く）', APP_URL + '?k=' + stg.key_mama],
    [txt_(stg.name_k1 || '上の子'), APP_URL + '?k=' + stg.key_k1],
    [txt_(stg.name_k2 || '下の子'), APP_URL + '?k=' + stg.key_k2]
  ]);
  sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 520);
}
function sheet_(ss, name, header) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
