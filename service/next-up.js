'use strict';

var zlib = require('zlib');

var BUCKET = Object.freeze({
    SMALL_BACKLOG: 0,
    CAUGHT_UP: 1,
    LARGE_BACKLOG: 2,
    NOT_STARTED: 3
});

function episodeOf(video) {
    return video.episode || parseInt(String(video.id || '').split(':').pop(), 10) || 0;
}

function seasonOf(video) {
    return null == video.season ? -2147483648 : video.season;
}

function sortVideos(videos) {
    return (videos || []).filter(function (video) {
        return video && video.id;
    }).slice().sort(function (a, b) {
        return seasonOf(a) - seasonOf(b) || episodeOf(a) - episodeOf(b) ||
            String(a.released || '').localeCompare(String(b.released || ''));
    });
}

function decodeWatched(field, videoIds) {
    var watched = {};
    if (!field || 'string' !== typeof field) return watched;
    try {
        var parts = field.split(':');
        if (parts.length < 3) return watched;
        var encoded = parts.pop();
        var anchorLength = parseInt(parts.pop(), 10);
        var anchorVideo = parts.join(':');
        var anchorIndex = videoIds.indexOf(anchorVideo);
        if (anchorIndex < 0 || !isFinite(anchorLength)) return watched;
        var values = zlib.inflateSync(Buffer.from(encoded, 'base64'));
        var offset = anchorLength - anchorIndex - 1;
        videoIds.forEach(function (videoId, index) {
            var oldIndex = index + offset;
            if (oldIndex < 0 || oldIndex >= values.length * 8) return;
            if ((values[Math.floor(oldIndex / 8)] >> (oldIndex % 8)) & 1) watched[videoId] = true;
        });
    } catch (e) {}
    return watched;
}

function hasStarted(state, watched) {
    return Object.keys(watched).length > 0 || Number(state.timesWatched || 0) > 0 ||
        Number(state.overallTimeWatched || 0) > 0 ||
        Number(state.timeWatched || 0) > 0 ||
        (Number(state.timeOffset || 0) > 1 && !!state.video_id);
}

function deepLinks(metaId, target) {
    var show = '#/detail/series/' + encodeURIComponent(metaId);
    return {
        metaDetailsVideos: show,
        metaDetailsStreams: target ? show + '/' + encodeURIComponent(target.id) : show
    };
}

function plan(item, meta, schedule, now) {
    var state = item.state || {};
    var allVideos = sortVideos((meta || {}).videos || []);
    var watched = decodeWatched(state.watched, allVideos.map(function (video) { return video.id; }));
    if (state.flaggedWatched && state.video_id) watched[state.video_id] = true;
    var regular = allVideos.filter(function (video) {
        return null == video.season || video.season > 0;
    });
    var isKitsu = /^kitsu:/.test(item._id || '');
    var uniqueMetaDates = {};
    regular.forEach(function (video) {
        if (video.released) uniqueMetaDates[video.released] = true;
    });
    var premiereStamped = isKitsu && regular.length > 1 && Object.keys(uniqueMetaDates).length <= 1;
    schedule = schedule || {};
    function releaseOf(video) {
        if (isKitsu) {
            var scheduled = schedule[episodeOf(video)];
            if (scheduled) return scheduled;
            if (premiereStamped) return null;
        }
        return video.released || null;
    }

    var nowIso = new Date(now || Date.now()).toISOString();
    var hasReleaseData = regular.some(function (video) { return !!releaseOf(video); });
    var released = hasReleaseData ? regular.filter(function (video) {
        var releasedAt = releaseOf(video);
        return releasedAt && releasedAt <= nowIso;
    }) : regular.slice();
    var future = regular.filter(function (video) {
        var releasedAt = releaseOf(video);
        return releasedAt && releasedAt > nowIso;
    }).sort(function (a, b) {
        return String(releaseOf(a)).localeCompare(String(releaseOf(b)));
    });

    var wholeSeriesWatched = Number(state.timesWatched || 0) > 0 && !state.watched &&
        Number(state.overallTimeWatched || 0) === 0 && Number(state.timeWatched || 0) === 0 &&
        Number(state.timeOffset || 0) <= 1;
    if (wholeSeriesWatched) released.forEach(function (video) { watched[video.id] = true; });

    var started = hasStarted(state, watched);
    var latestWatchedIndex = -1;
    regular.forEach(function (video, index) {
        if (watched[video.id]) latestWatchedIndex = index;
    });
    var backlogVideos = released.filter(function (video) {
        var index = regular.indexOf(video);
        return !watched[video.id] && (!started || index > latestWatchedIndex);
    });
    var current = released.filter(function (video) { return video.id === state.video_id; })[0] || null;
    if (current && started && regular.indexOf(current) <= latestWatchedIndex) current = null;
    var fraction = state.duration > 0 ? state.timeOffset / state.duration : 0;
    var target = current && !watched[current.id] && fraction > 0.02 ? current : (backlogVideos[0] || null);
    var progress = target && current && target.id === current.id && fraction > 0.02 ? Math.min(fraction, 1) : 0;
    var upcoming = future[0] || null;
    var backlog = backlogVideos.length;
    var bucket = !started ? BUCKET.NOT_STARTED : backlog > 3 ? BUCKET.LARGE_BACKLOG :
        backlog > 0 ? BUCKET.SMALL_BACKLOG : BUCKET.CAUGHT_UP;
    var latestRelease = null;
    released.forEach(function (video) {
        var releasedAt = releaseOf(video);
        if (releasedAt && (!latestRelease || releasedAt > latestRelease)) latestRelease = releasedAt;
    });

    return {
        item: item,
        meta: meta,
        watched: watched,
        started: started,
        backlog: backlog,
        bucket: bucket,
        target: target,
        progress: progress,
        upcoming: upcoming,
        nextRelease: upcoming ? releaseOf(upcoming) : null,
        latestRelease: latestRelease,
        include: !!(target || upcoming)
    };
}

function dateOrder(a, b) {
    if (a && b) return String(a).localeCompare(String(b));
    if (a) return -1;
    if (b) return 1;
    return 0;
}

function comparePlans(a, b) {
    var result = a.bucket - b.bucket;
    if (result) return result;
    if (a.bucket === BUCKET.LARGE_BACKLOG) {
        result = a.backlog - b.backlog;
        if (result) return result;
    }
    if (a.bucket !== BUCKET.NOT_STARTED) {
        result = dateOrder(a.nextRelease, b.nextRelease);
        if (result) return result;
    }
    if (a.latestRelease || b.latestRelease) {
        result = String(b.latestRelease || '').localeCompare(String(a.latestRelease || ''));
        if (result) return result;
    }
    var aState = (a.item || {}).state || {};
    var bState = (b.item || {}).state || {};
    result = String(bState.lastWatched || b.item._ctime || '').localeCompare(
        String(aState.lastWatched || a.item._ctime || ''));
    return result || String(a.item._id || '').localeCompare(String(b.item._id || ''));
}

function rank(plans, limit) {
    var ranked = (plans || []).filter(function (entry) { return entry && entry.include; }).slice().sort(comparePlans);
    return ranked.slice(0, null == limit ? 15 : limit);
}

module.exports = {
    BUCKET: BUCKET,
    decodeWatched: decodeWatched,
    deepLinks: deepLinks,
    plan: plan,
    rank: rank,
    sortVideos: sortVideos
};
