(function (root, factory) {
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.NextUpMenu = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    function video(item, metadata) {
        var videoId = item && item.nextUp && item.nextUp.videoId;
        if (!videoId || !metadata || !Array.isArray(metadata.videos)) return null;
        return metadata.videos.find(function (candidate) { return candidate.id === videoId; }) || null;
    }

    function watched(item, metadata) {
        var selected = video(item, metadata);
        return selected ? !!selected.watched : !!(metadata && metadata.watched);
    }

    function notifyLibraryChanged() {
        if (!root || !root.dispatchEvent || !root.setTimeout) return;
        [300, 2500, 6000].forEach(function (delay) {
            root.setTimeout(function () {
                root.dispatchEvent(new Event('libchange'));
            }, delay);
        });
    }

    function toggle(item, metadata, model, notify) {
        var selected = video(item, metadata);
        var result = selected ? model.toggleVideoWatched(selected) :
            model.setWatched(!watched(item, metadata));
        (notify || notifyLibraryChanged)();
        return result;
    }

    function hasDetails(item, progress) {
        return !!progress || !!(item && item.nextUp);
    }

    return {
        video: video,
        watched: watched,
        toggle: toggle,
        hasDetails: hasDetails
    };
});
