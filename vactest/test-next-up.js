const assert = require('node:assert/strict');
const test = require('node:test');

const nextUp = require('../service/next-up.js');

const NOW = '2026-09-01T12:00:00.000Z';

function videos(id, count) {
    return Array.from({ length: count }, (_, index) => ({
        id: `kitsu:${id}:${index + 1}`,
        episode: index + 1,
    }));
}

function schedule(firstDate, count, intervalDays = 7) {
    const first = new Date(firstDate).getTime();
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [
        index + 1,
        new Date(first + index * intervalDays * 86400000).toISOString(),
    ]));
}

function item(id, state) {
    return {
        _id: `kitsu:${id}`,
        type: 'series',
        removed: false,
        _ctime: '2026-07-01T00:00:00.000Z',
        state: {
            lastWatched: '2026-08-30T00:00:00.000Z',
            timeWatched: 0,
            timeOffset: 0,
            overallTimeWatched: 0,
            timesWatched: 0,
            duration: 1420000,
            video_id: null,
            watched: '',
            ...state,
        },
    };
}

test('watched bitfield overrides stale progress for a completed episode', () => {
    const bleach = nextUp.plan(
        item('49444', {
            timeOffset: 1103782,
            duration: 1473237,
            overallTimeWatched: 16722906,
            timesWatched: 6,
            video_id: 'kitsu:49444:6',
            watched: 'kitsu:49444:6:6:eJyzZwAAAIAAQA==',
        }),
        { videos: videos('49444', 10) },
        schedule('2026-07-25T14:00:00.000Z', 10),
        NOW,
    );

    assert.equal(bleach.backlog, 0);
    assert.equal(bleach.target, null);
    assert.equal(bleach.upcoming.id, 'kitsu:49444:7');
    assert.equal(bleach.bucket, nextUp.BUCKET.CAUGHT_UP);
});

test('one missed episode ranks before caught-up shows and large backlogs', () => {
    const rakudai = nextUp.plan(
        item('50793', {
            timeOffset: 1,
            overallTimeWatched: 26235258,
            timesWatched: 10,
            video_id: 'kitsu:50793:10',
            watched: 'kitsu:50793:9:9:eJz7z8gAAAMCAQE=',
        }),
        { videos: videos('50793', 12) },
        schedule('2026-06-25T15:00:00.000Z', 12),
        NOW,
    );
    const clevatess = nextUp.plan(
        item('50154', {
            timeOffset: 1208040,
            duration: 1420062,
            overallTimeWatched: 24252835,
            timesWatched: 9,
            video_id: 'kitsu:50154:8',
            watched: 'kitsu:50154:8:8:eJz7zwAAAgABAA==',
        }),
        { videos: videos('50154', 13) },
        schedule('2026-07-08T12:00:00.000Z', 13),
        NOW,
    );
    const youjo = nextUp.plan(
        item('44778', {
            timeOffset: 503363,
            duration: 1420063,
            overallTimeWatched: 72677,
            video_id: 'kitsu:44778:1',
        }),
        { videos: videos('44778', 12) },
        schedule('2026-07-08T12:30:00.000Z', 12),
        NOW,
    );
    const untouched = nextUp.plan(
        item('99999', {}),
        { videos: videos('99999', 12) },
        schedule('2026-07-01T12:00:00.000Z', 12),
        NOW,
    );

    assert.equal(rakudai.backlog, 1);
    assert.equal(rakudai.target.id, 'kitsu:50793:10');
    assert.equal(rakudai.bucket, nextUp.BUCKET.SMALL_BACKLOG);
    assert.equal(clevatess.backlog, 0);
    assert.equal(clevatess.bucket, nextUp.BUCKET.CAUGHT_UP);
    assert.equal(youjo.backlog, 8);
    assert.equal(youjo.bucket, nextUp.BUCKET.LARGE_BACKLOG);
    assert.equal(untouched.started, false);
    assert.equal(untouched.bucket, nextUp.BUCKET.NOT_STARTED);

    assert.deepEqual(
        nextUp.rank([untouched, youjo, clevatess, rakudai]).map(plan => plan.item._id),
        ['kitsu:50793', 'kitsu:50154', 'kitsu:44778', 'kitsu:99999'],
    );
});

test('sorting happens before the fifteen-card limit', () => {
    const filler = Array.from({ length: 20 }, (_, index) => ({
        item: item(`filler-${index}`, {}),
        bucket: nextUp.BUCKET.NOT_STARTED,
        nextRelease: null,
        backlog: 12,
        latestRelease: null,
        started: false,
        include: true,
    }));
    const priority = {
        item: item('priority', {}),
        bucket: nextUp.BUCKET.SMALL_BACKLOG,
        nextRelease: null,
        backlog: 1,
        latestRelease: '2026-08-01T00:00:00.000Z',
        started: true,
        include: true,
    };

    const result = nextUp.rank([...filler, priority], 15);
    assert.equal(result.length, 15);
    assert.equal(result[0].item._id, 'kitsu:priority');
});

test('old holes before the watched anchor do not become Next Up episodes', () => {
    const mushokuSchedule = {
        1: '2026-07-04T11:00:00.000Z',
        2: '2026-07-04T11:30:00.000Z',
        3: '2026-07-12T15:00:00.000Z',
        4: '2026-07-19T15:00:00.000Z',
        5: '2026-07-26T15:00:00.000Z',
        6: '2026-08-02T15:00:00.000Z',
        7: '2026-08-09T15:00:00.000Z',
        8: '2026-08-16T15:00:00.000Z',
        9: '2026-08-23T15:00:00.000Z',
        10: '2026-08-30T15:00:00.000Z',
        11: '2026-09-06T15:00:00.000Z',
        12: '2026-09-13T15:00:00.000Z',
        13: '2026-09-20T15:00:00.000Z',
        14: '2026-09-27T11:00:00.000Z',
    };
    const mushoku = nextUp.plan(
        item('49002', {
            timeOffset: 1,
            overallTimeWatched: 29334470,
            timesWatched: 10,
            video_id: 'kitsu:49002:11',
            watched: 'kitsu:49002:10:10:eJz7xwwAAgEBAg==',
        }),
        { videos: videos('49002', 14) },
        mushokuSchedule,
        NOW,
    );

    assert.equal(mushoku.backlog, 0);
    assert.equal(mushoku.target, null);
    assert.equal(mushoku.upcoming.id, 'kitsu:49002:11');
});

test('stale progress before the watched anchor does not resurrect an old episode', () => {
    const plan = nextUp.plan(
        item('old-progress', {
            timeOffset: 700000,
            duration: 1400000,
            overallTimeWatched: 14000000,
            timesWatched: 10,
            video_id: 'kitsu:old-progress:1',
            watched: 'kitsu:old-progress:10:10:eJz7xwwAAgEBAg==',
        }),
        { videos: videos('old-progress', 12) },
        schedule('2026-06-28T11:00:00.000Z', 12),
        NOW,
    );

    assert.equal(plan.backlog, 0);
    assert.equal(plan.target, null);
    assert.equal(plan.upcoming.id, 'kitsu:old-progress:11');
});

test('future-only dates are not treated as already aired', () => {
    const plan = nextUp.plan(
        item('future', {}),
        { videos: videos('future', 2) },
        { 1: '2026-09-02T00:00:00.000Z', 2: '2026-09-09T00:00:00.000Z' },
        NOW,
    );

    assert.equal(plan.backlog, 0);
    assert.equal(plan.target, null);
    assert.equal(plan.upcoming.id, 'kitsu:future:1');
});

test('a whole-series watched action is caught up when no episode bitfield exists', () => {
    const markedWatched = nextUp.plan(
        item('whole-show', { timesWatched: 1 }),
        { videos: videos('whole-show', 12) },
        schedule('2026-07-08T12:00:00.000Z', 12),
        NOW,
    );

    assert.equal(markedWatched.started, true);
    assert.equal(markedWatched.backlog, 0);
    assert.equal(markedWatched.target, null);
    assert.equal(markedWatched.upcoming.id, 'kitsu:whole-show:9');
    assert.equal(markedWatched.bucket, nextUp.BUCKET.CAUGHT_UP);
});

test('completed shows with no next episode are omitted', () => {
    const completed = nextUp.plan(
        item('completed', {
            timesWatched: 1,
            video_id: 'kitsu:completed:3',
            watched: 'kitsu:completed:3:3:eJz7zwAAAgABAA==',
        }),
        { videos: videos('completed', 3) },
        schedule('2026-07-01T12:00:00.000Z', 3),
        NOW,
    );

    assert.equal(completed.include, false);
    assert.deepEqual(nextUp.rank([completed]), []);
});

test('card links send Play to the episode and Details to the show', () => {
    assert.deepEqual(nextUp.deepLinks('kitsu:49444', { id: 'kitsu:49444:7' }), {
        metaDetailsVideos: '#/detail/series/kitsu%3A49444',
        metaDetailsStreams: '#/detail/series/kitsu%3A49444/kitsu%3A49444%3A7',
    });
});
