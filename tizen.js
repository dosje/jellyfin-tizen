(function () {
    'use strict';

    console.log('Tizen adapter');

    // Similar to jellyfin-web
    function generateDeviceId() {
        return btoa([navigator.userAgent, new Date().getTime()].join('|')).replace(/=/g, '1');
    }

    function getDeviceId() {
        // Use variable '_deviceId2' to mimic jellyfin-web

        var deviceId = localStorage.getItem('_deviceId2');

        if (!deviceId) {
            deviceId = generateDeviceId();
            localStorage.setItem('_deviceId2', deviceId);
        }

        return deviceId;
    }

    var AppInfo = {
        deviceId: getDeviceId(),
        deviceName: 'Samsung Smart TV',
        appName: 'Jellyfin for Tizen',
        appVersion: tizen.application.getCurrentApplication().appInfo.version
    };

    // List of supported features
    var SupportedFeatures = [
        'exit',
        'exitmenu',
        'externallinkdisplay',
        'htmlaudioautoplay',
        'htmlvideoautoplay',
        'physicalvolumecontrol',
        'displaylanguage',
        'otherapppromotions',
        'targetblank',
        'screensaver',
        'multiserver',
        'subtitleappearancesettings',
        'subtitleburnsettings'
    ];

    var systeminfo;

    function getSystemInfo() {
        if (systeminfo) {
            return Promise.resolve(systeminfo);
        }

        return new Promise(function (resolve) {
            tizen.systeminfo.getPropertyValue('DISPLAY', function (result) {
                var devicePixelRatio = 1;

                if (typeof webapis.productinfo.is8KPanelSupported === 'function' && webapis.productinfo.is8KPanelSupported()){
                    console.log("8K UHD is supported");
                    devicePixelRatio = 4;
                } else if (typeof webapis.productinfo.isUdPanelSupported === 'function' && webapis.productinfo.isUdPanelSupported()){
                    console.log("4K UHD is supported");
                    devicePixelRatio = 2;
                } else {
                    console.log("UHD is not supported");
                }

                systeminfo = Object.assign({}, result, {
                    resolutionWidth: Math.floor(result.resolutionWidth * devicePixelRatio),
                    resolutionHeight: Math.floor(result.resolutionHeight * devicePixelRatio)
                });

                resolve(systeminfo)
            });
        });
    }

    function postMessage() {
        console.log.apply(console, arguments);
    }

    // ---------------------------------------------------------------------------
    // FIX #1: Live TV — prefetch the HLS playlist before handing URL to <video>
    //
    // Problem: On Tizen, Live TV streams (no RunTimeTicks, HLS, transcoded) show
    // a black screen / spinner indefinitely. The root cause is that Tizen's native
    // HLS player starts loading master.m3u8 before the server has generated any
    // segments, so it immediately fails and shows nothing.
    //
    // The same pre-fetch workaround already exists in htmlVideoPlayer/plugin.js
    // for iOS/macOS (browser.iOS || browser.osx). We replicate the intent here at
    // the adapter layer by monkey-patching applySrc so that, for live HLS streams,
    // we first poll the live.m3u8 playlist URL until the server responds 200 before
    // setting elem.src. This gives the transcoder time to produce at least one
    // segment before the player tries to load.
    //
    // The timeout (MAX_WAIT_MS) prevents the spinner from hanging forever if the
    // stream truly fails — after that we fall through to the normal assignment so
    // the player's own error handling can take over.
    // ---------------------------------------------------------------------------

    var LIVE_TV_PREFETCH_INTERVAL_MS = 800;
    var LIVE_TV_PREFETCH_MAX_WAIT_MS = 10000;
    var LIVE_TV_FETCH_TIMEOUT_MS = 5000;

    function isHlsUrl(url) {
        return url && url.indexOf('.m3u8') !== -1;
    }

    // Returns a cancel() function. Calling it stops any pending fetch/retry.
    function prefetchLiveTvPlaylist(masterUrl, callback) {
        var liveUrl = masterUrl.replace('master.m3u8', 'live.m3u8');
        var waited = 0;
        var cancelled = false;

        function cancel() { cancelled = true; }

        console.log('[Tizen][LiveTV] Prefetching HLS playlist:', liveUrl);

        function attempt() {
            if (cancelled) return;

            var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var fetchTimeout = controller
                ? setTimeout(function () { controller.abort(); }, LIVE_TV_FETCH_TIMEOUT_MS)
                : null;
            var fetchOptions = controller ? { signal: controller.signal } : {};

            fetch(liveUrl, fetchOptions)
                .then(function (res) {
                    if (fetchTimeout) clearTimeout(fetchTimeout);
                    if (cancelled) return;
                    if (res.ok) {
                        console.log('[Tizen][LiveTV] Playlist ready, proceeding with playback');
                        callback(null, liveUrl);
                    } else if (waited < LIVE_TV_PREFETCH_MAX_WAIT_MS) {
                        waited += LIVE_TV_PREFETCH_INTERVAL_MS;
                        setTimeout(attempt, LIVE_TV_PREFETCH_INTERVAL_MS);
                    } else {
                        console.warn('[Tizen][LiveTV] Prefetch timed out, falling back to master URL');
                        callback(null, masterUrl);
                    }
                })
                .catch(function (err) {
                    if (fetchTimeout) clearTimeout(fetchTimeout);
                    if (cancelled) return;
                    if (waited < LIVE_TV_PREFETCH_MAX_WAIT_MS) {
                        waited += LIVE_TV_PREFETCH_INTERVAL_MS;
                        setTimeout(attempt, LIVE_TV_PREFETCH_INTERVAL_MS);
                    } else {
                        console.warn('[Tizen][LiveTV] Prefetch failed:', err, '— falling back');
                        callback(null, masterUrl);
                    }
                });
        }

        attempt();
        return cancel;
    }

    // ---------------------------------------------------------------------------
    // FIX #2: Chapter/segment seeking — force a small seek retry on Tizen
    //
    // Problem: After calling videoElement.currentTime = seconds, Tizen's WebView
    // sometimes silently resets back to 0 (observed with .strm sources and certain
    // remuxed files). This happens because the seekable range isn't updated yet
    // when the seek is issued, so the platform ignores it.
    //
    // Fix: After setting currentTime, we listen for the next 'seeked' event and
    // verify the position landed within 2 s of the target. If not, we retry once
    // after a short delay. This matches the pattern used by hls.js internally to
    // handle "nudge" seeks on stalled playback.
    // ---------------------------------------------------------------------------

    var SEEK_VERIFY_TOLERANCE_S = 2;
    var SEEK_RETRY_DELAY_MS = 300;
    var SEEK_MAX_RETRIES = 2;

    function installSeekVerifier(videoElement, targetSeconds, retryCount) {
        retryCount = retryCount || 0;

        // Remove any previously installed verifier and cancel any pending retry timer
        if (videoElement._tizenSeekHandler) {
            videoElement.removeEventListener('seeked', videoElement._tizenSeekHandler);
            videoElement._tizenSeekHandler = null;
        }
        if (videoElement._tizenSeekTimer) {
            clearTimeout(videoElement._tizenSeekTimer);
            videoElement._tizenSeekTimer = null;
        }

        if (retryCount >= SEEK_MAX_RETRIES) {
            console.warn('[Tizen][Seek] Max retries reached for target', targetSeconds);
            return;
        }

        function onSeeked() {
            videoElement.removeEventListener('seeked', onSeeked);
            videoElement._tizenSeekHandler = null;

            var actual = videoElement.currentTime;
            var delta = Math.abs(actual - targetSeconds);

            // Only retry if targetSeconds is within the seekable range — the stated root
            // cause is that the platform ignores seeks outside the buffered range.
            var isInSeekableRange = false;
            var seekable = videoElement.seekable;
            if (seekable && seekable.length > 0) {
                for (var i = 0; i < seekable.length; i++) {
                    if (targetSeconds >= seekable.start(i) && targetSeconds <= seekable.end(i)) {
                        isInSeekableRange = true;
                        break;
                    }
                }
            }

            if (delta > SEEK_VERIFY_TOLERANCE_S && targetSeconds > 0 && isInSeekableRange) {
                console.warn('[Tizen][Seek] Position mismatch: expected', targetSeconds,
                    'got', actual, '— retry', retryCount + 1, 'of', SEEK_MAX_RETRIES);
                videoElement._tizenSeekTimer = setTimeout(function () {
                    videoElement._tizenSeekTimer = null;
                    if (videoElement && videoElement.readyState >= 1) {
                        // Install the next verifier before seeking to avoid re-entering
                        // the patched setter (which would reset retryCount to 0).
                        installSeekVerifier(videoElement, targetSeconds, retryCount + 1);
                        nativeCurrentTimeSetter.call(videoElement, targetSeconds);
                    }
                }, SEEK_RETRY_DELAY_MS);
            } else {
                console.debug('[Tizen][Seek] Seek verified OK at', actual);
            }
        }

        videoElement._tizenSeekHandler = onSeeked;
        videoElement.addEventListener('seeked', onSeeked);
    }

    window.NativeShell = {
        AppHost: {
            init: function () {
                postMessage('AppHost.init', AppInfo);
                return getSystemInfo().then(function () {
                    return Promise.resolve(AppInfo);
                });
            },

            appName: function () {
                postMessage('AppHost.appName', AppInfo.appName);
                return AppInfo.appName;
            },

            appVersion: function () {
                postMessage('AppHost.appVersion', AppInfo.appVersion);
                return AppInfo.appVersion;
            },

            deviceId: function () {
                postMessage('AppHost.deviceId', AppInfo.deviceId);
                return AppInfo.deviceId;
            },

            deviceName: function () {
                postMessage('AppHost.deviceName', AppInfo.deviceName);
                return AppInfo.deviceName;
            },

            exit: function () {
                postMessage('AppHost.exit');
                tizen.application.getCurrentApplication().exit();
            },

            getDefaultLayout: function () {
                postMessage('AppHost.getDefaultLayout', 'tv');
                return 'tv';
            },

            getDeviceProfile: function (profileBuilder) {
                postMessage('AppHost.getDeviceProfile');
                return profileBuilder({ enableMkvProgressive: false, enableSsaRender: true });
            },

            getSyncProfile: function (profileBuilder) {
                postMessage('AppHost.getSyncProfile');
                return profileBuilder({ enableMkvProgressive: false });
            },

            screen: function () {
                return systeminfo ? {
                    width: systeminfo.resolutionWidth,
                    height: systeminfo.resolutionHeight
                } : null;
            },

            supports: function (command) {
                var isSupported = command && SupportedFeatures.indexOf(command.toLowerCase()) != -1;
                postMessage('AppHost.supports', {
                    command: command,
                    isSupported: isSupported
                });
                return isSupported;
            }
        },

        downloadFile: function (url) {
            postMessage('downloadFile', { url: url });
        },

        enableFullscreen: function () {
            postMessage('enableFullscreen');
        },

        disableFullscreen: function () {
            postMessage('disableFullscreen');
        },

        getPlugins: function () {
            postMessage('getPlugins');
            return [];
        },

        openUrl: function (url, target) {
            postMessage('openUrl', {
                url: url,
                target: target
            });
        },

        updateMediaSession: function (mediaInfo) {
            postMessage('updateMediaSession', { mediaInfo: mediaInfo });
        },

        hideMediaSession: function () {
            postMessage('hideMediaSession');
        }
    };

    window.addEventListener('load', function () {
        tizen.tvinputdevice.registerKey('MediaPlay');
        tizen.tvinputdevice.registerKey('MediaPause');
        tizen.tvinputdevice.registerKey('MediaStop');
        tizen.tvinputdevice.registerKey('MediaTrackPrevious');
        tizen.tvinputdevice.registerKey('MediaTrackNext');
        tizen.tvinputdevice.registerKey('MediaRewind');
        tizen.tvinputdevice.registerKey('MediaFastForward');

        // ---------------------------------------------------------------------------
        // Apply Fix #1 and Fix #2 by intercepting the HTMLVideoElement prototype
        // after the page has loaded (jellyfin-web creates video elements dynamically).
        // We patch HTMLMediaElement.prototype so every <video> element the web app
        // creates automatically gets our fixes without needing to modify jellyfin-web.
        // ---------------------------------------------------------------------------

        var nativeCurrentTimeSetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime').set;
        var nativeCurrentTimeGetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime').get;

        // FIX #2 — intercept currentTime setter to install seek verifier
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            get: function () {
                return nativeCurrentTimeGetter.call(this);
            },
            set: function (seconds) {
                // Only verify seeks for video elements with a real target time.
                // Pass retryCount=0 so the verifier knows this is a fresh user-initiated seek.
                if (this.tagName === 'VIDEO' && seconds > 0 && this.readyState >= 1) {
                    installSeekVerifier(this, seconds, 0);
                }
                nativeCurrentTimeSetter.call(this, seconds);
            },
            configurable: true
        });

        // FIX #1 — intercept src setter to pre-fetch live HLS playlist
        var nativeSrcSetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src').set;
        var nativeSrcGetter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src').get;

        Object.defineProperty(HTMLMediaElement.prototype, 'src', {
            get: function () {
                return nativeSrcGetter.call(this);
            },
            set: function (url) {
                var elem = this;

                // Cancel any in-flight prefetch for this element so a rapid src change
                // (e.g. channel switch) cannot apply a stale URL after the new one was set.
                if (elem._tizenPrefetchCancel) {
                    elem._tizenPrefetchCancel();
                    elem._tizenPrefetchCancel = null;
                    elem._tizenPrefetchUrl = null;
                }

                // Detect Live TV HLS: URL contains master.m3u8 with no RunTimeTicks context.
                // We identify "live" by the presence of 'master.m3u8' AND the absence of
                // a '#t=' fragment (which is added for VOD resume by jellyfin-web).
                if (isHlsUrl(url) && url.indexOf('master.m3u8') !== -1 && url.indexOf('#t=') === -1) {
                    elem._tizenPrefetchUrl = url;
                    elem._tizenPrefetchCancel = prefetchLiveTvPlaylist(url, function (err, resolvedUrl) {
                        // Guard: only apply if this is still the URL this element wants.
                        if (elem._tizenPrefetchUrl !== url) return;
                        elem._tizenPrefetchUrl = null;
                        elem._tizenPrefetchCancel = null;
                        nativeSrcSetter.call(elem, resolvedUrl || url);
                    });
                } else {
                    nativeSrcSetter.call(elem, url);
                }
            },
            configurable: true
        });

        // ---------------------------------------------------------------------------
        // FIX #3: Live TV Guide — vertical scroll follows focus on Tizen
        //
        // Problem: jellyfin-web's scroller.js calculates frameSize == slideeSize for
        // the .guideVerticalScroller (regression from PR #5070), making the scroll
        // offset always 0. On Tizen there is no CSS scroll fallback, so the selected
        // channel row moves off-screen while the container stays stuck at the top.
        // Reported: jellyfin-tizen #342, #346; jellyfin-web #5705, #7198.
        //
        // Two-layer fix:
        //   Layer 1 — CSS: inflate .guideVerticalScroller padding so the scroller's
        //             frameSize calculation produces a non-zero result. Uses vh units
        //             so it works correctly on both 1080p and 4K panels.
        //   Layer 2 — JS: listen for focusin events inside .guideVerticalScroller and
        //             call scrollIntoView() to guarantee the focused row is visible
        //             even if the scroller's own JS still misbehaves after a re-entry.
        // ---------------------------------------------------------------------------

        // Layer 1 — inject CSS
        (function injectGuideScrollCss() {
            var style = document.createElement('style');
            style.textContent = [
                '.layout-tv .liveTvContainer .guideVerticalScroller {',
                '    padding-bottom: 69vh !important;',
                '    padding-top: 9vh !important;',
                '}'
            ].join('\n');
            document.head.appendChild(style);
            console.log('[Tizen][GuideScroll] CSS patch injected');
        }());

        // Layer 2 — focusin handler: scroll only the guide container, not ancestors
        (function installGuideScrollHandler() {
            var scrollDebounce = null;

            document.addEventListener('focusin', function (e) {
                if (scrollDebounce) {
                    clearTimeout(scrollDebounce);
                }
                scrollDebounce = setTimeout(function () {
                    scrollDebounce = null;
                    var target = e.target;
                    if (!target || !target.closest) return;
                    var scroller = target.closest('.guideVerticalScroller');
                    if (!scroller) return;

                    // Directly adjust the guide container's scrollTop so we don't
                    // accidentally scroll any other ancestor element.
                    var scrollerRect = scroller.getBoundingClientRect();
                    var targetRect = target.getBoundingClientRect();

                    if (targetRect.bottom > scrollerRect.bottom) {
                        scroller.scrollTop += Math.round(targetRect.bottom - scrollerRect.bottom);
                    } else if (targetRect.top < scrollerRect.top) {
                        scroller.scrollTop -= Math.round(scrollerRect.top - targetRect.top);
                    }
                    // else: already in view — no-op
                }, 50);
            });

            console.log('[Tizen][GuideScroll] focusin handler installed');
        }());

        console.log('[Tizen] Live TV prefetch, seek verifier, and guide scroll patches applied');
    });

    function updateKeys() {
        if (location.hash.indexOf('/queue') !== -1 || location.hash.indexOf('/video') !== -1) {
            // Disable on-screen playback control, if available on the page
            tizen.tvinputdevice.registerKey('MediaPlayPause');
        } else {
            tizen.tvinputdevice.unregisterKey('MediaPlayPause');
        }
    }

    window.addEventListener('viewshow', updateKeys);
})();
