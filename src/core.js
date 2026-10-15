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
 * 書きかえた物には _dirty、新しく足した物には _new の印をつける（GAS はこの印を見てシートに書く）
 */
var CORE = (function () {
  var MAX_YEN = 100000;          // 1回の金額・チップ・引き出しの上限
  var NAME_MAX = 10;             // 子どもの呼び名
  var CHORE_MAX = 20;            // お手伝いの名前
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

  return { apply: apply, view: view, balance: balance, waitingWithdraw: waitingWithdraw, toInt: toInt, cleanText: cleanText, MAX_YEN: MAX_YEN, NAME_MAX: NAME_MAX, CHORE_MAX: CHORE_MAX };
})();
