/* anime-page.js — native "Anime" page renderer.
 *
 * Mounted by the /anime route component (discover.chunk.js -> X) into the app's
 * content area (not an overlay). Renders, home-style, a stack of titled rows:
 *   Row 0  : "Trending"        — relevance order (poster cards)
 *   Rows 1-7: each WEEKDAY starting today — shows airing that day, soonest first,
 *             as landscape cards with a live countdown + episode counter + a
 *             fill bar for time-until-airing (à la anilind).
 *
 * Everything updates live because the app can stay open for days:
 *   - countdowns/progress recompute every second from the absolute airingAt,
 *   - the day grouping re-buckets when the local weekday rolls over at midnight,
 *   - the underlying data refetches every 30 min to pick up new next-episodes.
 *
 * Items keep kitsu: ids so clicking routes to the normal detail page and all
 * the stream/subtitle/audio plumbing keeps working.
 */
(function () {
    var WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var WEEK_SHORT = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    var FEED = '/anime-airing/schedule-week.json';
    var REFRESH_MS = 30 * 60 * 1000;

    var S = null; // active state, or null when unmounted

    var CSS = [
        '.ap-root{position:relative;height:100%;width:100%;background:#0c0c10;color:hsla(0,0%,100%,.9);font-family:"Plus Jakarta Sans",system-ui,sans-serif;overflow:hidden}',
        '.ap-scroller{position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;padding:2rem 0 4rem 4rem}',
        '.ap-scroller::-webkit-scrollbar{display:none}',
        '.ap-msg,.ap-empty{color:hsla(0,0%,100%,.45);font-size:1.6rem;padding:2rem 0}',
        '.ap-row{margin-bottom:2.4rem}',
        '.ap-row-title{font-size:1.9rem;font-weight:700;margin:0 0 1rem 0;color:hsla(0,0%,100%,.9)}',
        '.ap-strip{display:flex;flex-direction:row;gap:1.2rem;overflow-x:hidden;overflow-y:visible;padding:1rem 4rem 1rem 0}',
        '.ap-card{position:relative;flex:0 0 auto;border-radius:.8rem;overflow:hidden;background:rgba(255,255,255,.03);opacity:.55;transition:transform .12s ease-out,opacity .12s ease-out;cursor:pointer}',
        '.ap-card[data-foc]{opacity:1;transform:scale(1.06);box-shadow:0 0 0 .35rem #7b5bf5,0 1.4rem 3rem rgba(0,0,0,.7);z-index:2}',
        '.ap-card:hover{opacity:1}',
        /* poster (trending) */
        '.ap-poster{width:14.8rem;height:22rem}',
        '.ap-poster-img{position:absolute;inset:0;height:100%;width:100%;object-fit:cover}',
        '.ap-poster-title{position:absolute;left:0;right:0;bottom:0;padding:2.4rem .6rem .6rem;font-size:1.2rem;line-height:1.2;text-align:center;background:linear-gradient(transparent,rgba(0,0,0,.92));display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
        /* day card (landscape, anilind-style) */
        '.ap-daycard{width:30rem;height:15rem}',
        '.ap-bg{position:absolute;inset:0;background-size:cover;background-position:center;filter:brightness(.4)}',
        '.ap-grad{position:absolute;inset:0;background:linear-gradient(90deg,rgba(12,12,16,.95) 0%,rgba(12,12,16,.35) 55%,transparent 100%)}',
        '.ap-cover{position:absolute;top:1.2rem;bottom:1.8rem;left:1.2rem;height:auto;width:8.4rem;object-fit:cover;border-radius:.5rem;box-shadow:0 .4rem 1rem rgba(0,0,0,.5)}',
        '.ap-badge{position:absolute;top:1.2rem;left:1.2rem;width:8.4rem;background:rgba(0,0,0,.62);border-radius:.5rem .5rem 0 0;padding:.3rem 0;text-align:center}',
        '.ap-badge-day{font-size:1.1rem;font-weight:700;letter-spacing:.05em;color:#fff}',
        '.ap-badge-time{font-size:.95rem;color:hsla(0,0%,100%,.7)}',
        '.ap-info{position:absolute;left:10.8rem;right:1.2rem;top:1.4rem;bottom:1.6rem;display:flex;flex-direction:column}',
        '.ap-title{font-size:1.45rem;font-weight:700;line-height:1.2;color:#fff;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
        '.ap-countdown{margin-top:auto;font-size:1.2rem;color:#7b5bf5;font-weight:600}',
        '.ap-ep{font-size:1.15rem;color:hsla(0,0%,100%,.6);margin-top:.2rem}',
        '.ap-bar{position:absolute;left:0;right:0;bottom:0;height:.4rem;background:rgba(255,255,255,.12)}',
        '.ap-bar-in{height:100%;width:0;background:#7b5bf5}'
    ].join('');

    function injectCss() {
        if (document.getElementById('ap-style')) return;
        var s = document.createElement('style');
        s.id = 'ap-style'; s.textContent = CSS;
        document.head.appendChild(s);
    }

    function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
    function nowSec() { return Math.floor(Date.now() / 1000); }

    function fmtCountdown(sec) {
        if (sec <= 0) return 'airing now';
        var d = Math.floor(sec / 86400),
            h = Math.floor((sec % 86400) / 3600),
            m = Math.floor((sec % 3600) / 60);
        var out = [];
        if (d) out.push(d + 'd');
        if (h) out.push(h + 'h');
        if (!d) out.push(m + 'm'); // drop minutes once we're days out (matches anilind)
        return 'in ' + out.join(' ');
    }
    function fmtTime(epoch) {
        try {
            return new Date(epoch * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        } catch (e) { return ''; }
    }
    function pctUntilAiring(airingAt) {
        var left = airingAt - nowSec();
        if (left <= 0) return 100;
        var p = 100 - (left / 604800) * 100; // fraction of the week elapsed toward air
        return Math.max(0, Math.min(100, p));
    }
    function epLabel(it) {
        if (it.nextEpisode && it.totalEpisodes) return 'EP ' + it.nextEpisode + ' / ' + it.totalEpisodes;
        if (it.nextEpisode) return 'EP ' + it.nextEpisode;
        return '';
    }

    // ---- row/card construction --------------------------------------------

    function posterCard(it) {
        var c = el('div', 'ap-card ap-poster');
        c.setAttribute('data-id', it.id);
        var img = el('img', 'ap-poster-img');
        img.src = it.poster || it.background || '';
        img.onerror = function () { this.style.visibility = 'hidden'; };
        var t = el('div', 'ap-poster-title');
        t.textContent = it.name || '';
        c.appendChild(img);
        c.appendChild(t);
        return c;
    }

    function dayCard(it) {
        var c = el('div', 'ap-card ap-daycard');
        c.setAttribute('data-id', it.id);
        c.setAttribute('data-air', it.airingAt);

        var bg = el('div', 'ap-bg');
        if (it.banner || it.background) bg.style.backgroundImage = 'url("' + (it.banner || it.background) + '")';
        var grad = el('div', 'ap-grad');

        var cover = el('img', 'ap-cover');
        cover.src = it.poster || '';
        cover.onerror = function () { this.style.visibility = 'hidden'; };

        var badge = el('div', 'ap-badge');
        var bday = el('div', 'ap-badge-day'); bday.textContent = WEEK_SHORT[new Date(it.airingAt * 1000).getDay()];
        var btime = el('div', 'ap-badge-time'); btime.textContent = fmtTime(it.airingAt);
        badge.appendChild(bday); badge.appendChild(btime);

        var info = el('div', 'ap-info');
        var title = el('div', 'ap-title'); title.textContent = it.name || '';
        var cd = el('div', 'ap-countdown'); cd.textContent = fmtCountdown(it.airingAt - nowSec());
        var ep = el('div', 'ap-ep'); ep.textContent = epLabel(it);
        info.appendChild(title); info.appendChild(cd); info.appendChild(ep);

        var bar = el('div', 'ap-bar');
        var barIn = el('div', 'ap-bar-in'); barIn.style.width = pctUntilAiring(it.airingAt) + '%';
        bar.appendChild(barIn);

        c.appendChild(bg); c.appendChild(grad);
        c.appendChild(cover); c.appendChild(badge); c.appendChild(info); c.appendChild(bar);
        // stash live nodes for cheap per-second updates
        c._cd = cd; c._bar = barIn;
        return c;
    }

    function buildRow(name, items, kind) {
        var row = el('div', 'ap-row');
        var h = el('div', 'ap-row-title'); h.textContent = name;
        var strip = el('div', 'ap-strip');
        var cards = [];
        for (var i = 0; i < items.length; i++) {
            var card = (kind === 'poster') ? posterCard(items[i]) : dayCard(items[i]);
            strip.appendChild(card);
            cards.push(card);
        }
        if (!items.length) {
            var none = el('div', 'ap-empty'); none.textContent = 'Nothing scheduled';
            strip.appendChild(none);
        }
        row.appendChild(h); row.appendChild(strip);
        return { name: name, el: row, strip: strip, cards: cards, items: items };
    }

    function groupByDay(metas) {
        var today = new Date().getDay();
        var rows = [];
        // Trending / relevance (all, in feed order).
        rows.push(buildRow('Trending', metas, 'poster'));
        // Seven weekday rows, starting today.
        for (var i = 0; i < 7; i++) {
            var wd = (today + i) % 7;
            var dayItems = metas.filter(function (m) {
                return m.airingAt && new Date(m.airingAt * 1000).getDay() === wd;
            }).sort(function (a, b) { return a.airingAt - b.airingAt; });
            var label = (i === 0 ? 'Today · ' : i === 1 ? 'Tomorrow · ' : '') + WEEK[wd];
            rows.push(buildRow(label, dayItems, 'day'));
        }
        return rows;
    }

    // ---- focus / navigation ------------------------------------------------

    function applyFocus() {
        var rows = S.rows, f = S.focus;
        for (var r = 0; r < rows.length; r++)
            for (var c = 0; c < rows[r].cards.length; c++)
                rows[r].cards[c].removeAttribute('data-foc');
        var row = rows[f.r]; if (!row || !row.cards.length) return;
        var card = row.cards[f.c]; if (!card) return;
        card.setAttribute('data-foc', '1');
        // horizontal: keep focused card in view within its strip
        var strip = row.strip;
        var left = card.offsetLeft, right = left + card.offsetWidth;
        if (left < strip.scrollLeft + 16) strip.scrollLeft = left - 16;
        else if (right > strip.scrollLeft + strip.clientWidth - 16) strip.scrollLeft = right - strip.clientWidth + 16;
        // vertical: keep focused row in view within the page
        var page = S.scroller;
        var top = row.el.offsetTop, bot = top + row.el.offsetHeight;
        if (top < page.scrollTop + 8) page.scrollTop = top - 8;
        else if (bot > page.scrollTop + page.clientHeight - 8) page.scrollTop = bot - page.clientHeight + 8;
    }

    function moveTo(r, c) {
        var rows = S.rows;
        if (r < 0) r = 0; if (r > rows.length - 1) r = rows.length - 1;
        // skip empty rows in the chosen vertical direction
        while (rows[r] && !rows[r].cards.length && r > 0 && r < rows.length - 1) r += (r > S.focus.r ? 1 : -1);
        var row = rows[r]; if (!row) return;
        if (c < 0) c = 0; if (c > row.cards.length - 1) c = row.cards.length - 1;
        S.focus.r = r; S.focus.c = c < 0 ? 0 : c;
        applyFocus();
    }

    function openFocused() {
        var row = S.rows[S.focus.r]; if (!row) return;
        var it = row.items[S.focus.c]; if (!it || !it.id) return;
        location.hash = '#/detail/series/' + encodeURIComponent(it.id);
    }

    function onKey(e) {
        if (!S) return;
        var k = e.keyCode, f = S.focus, row = S.rows[f.r];
        switch (k) {
            case 39: // right
                if (row && f.c < row.cards.length - 1) { moveTo(f.r, f.c + 1); stop(e); }
                else stop(e);
                break;
            case 37: // left — at the first column, let the app move focus to the sidebar
                if (f.c > 0) { moveTo(f.r, f.c - 1); stop(e); }
                break;
            case 38: moveTo(f.r - 1, f.c); stop(e); break; // up
            case 40: moveTo(f.r + 1, f.c); stop(e); break; // down
            case 13: openFocused(); stop(e); break;        // enter
            default: break; // Back/others fall through to the app
        }
    }
    function stop(e) { e.preventDefault(); e.stopPropagation(); }

    // ---- lifecycle ---------------------------------------------------------

    function render(metas) {
        if (!S) return;
        S.root.innerHTML = '';
        var scroller = el('div', 'ap-scroller');
        var rows = groupByDay(metas);
        for (var i = 0; i < rows.length; i++) scroller.appendChild(rows[i].el);
        S.root.appendChild(scroller);
        S.scroller = scroller;
        S.rows = rows;
        S.metas = metas;
        S.todayDay = new Date().getDay();
        // focus first non-empty row
        S.focus = { r: 0, c: 0 };
        for (var r = 0; r < rows.length; r++) { if (rows[r].cards.length) { S.focus.r = r; break; } }
        applyFocus();
    }

    function tick() {
        if (!S || !S.rows) return;
        // midnight rollover -> re-bucket the weekday rows
        if (new Date().getDay() !== S.todayDay) { render(S.metas); return; }
        var now = nowSec();
        for (var r = 1; r < S.rows.length; r++) {
            var cards = S.rows[r].cards, items = S.rows[r].items;
            for (var c = 0; c < cards.length; c++) {
                var card = cards[c], it = items[c];
                if (!it || !it.airingAt) continue;
                if (card._cd) card._cd.textContent = fmtCountdown(it.airingAt - now);
                if (card._bar) card._bar.style.width = pctUntilAiring(it.airingAt) + '%';
            }
        }
    }

    function load() {
        fetch(FEED).then(function (r) { return r.json(); }).then(function (d) {
            if (!S) return;
            render((d && d.metas) || []);
        }).catch(function () {
            if (S && S.root) S.root.innerHTML = '<div class="ap-msg">Couldn\'t load the schedule.</div>';
        });
    }

    function mount(root) {
        unmount();
        injectCss();
        S = { root: root, rows: null, metas: [], focus: { r: 0, c: 0 }, scroller: null, todayDay: -1 };
        root.innerHTML = '<div class="ap-msg">Loading current season…</div>';
        S.onKey = onKey;
        document.addEventListener('keydown', S.onKey, true);
        S.tick = setInterval(tick, 1000);
        S.refresh = setInterval(load, REFRESH_MS);
        load();
    }

    function unmount() {
        if (!S) return;
        try { document.removeEventListener('keydown', S.onKey, true); } catch (e) {}
        if (S.tick) clearInterval(S.tick);
        if (S.refresh) clearInterval(S.refresh);
        try { if (S.root) S.root.innerHTML = ''; } catch (e) {}
        S = null;
    }

    window.__animePage = { mount: mount, unmount: unmount };
})();
