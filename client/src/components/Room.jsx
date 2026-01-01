import React, { useState, useEffect, useRef } from 'react';
import YouTube from 'react-youtube';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query as fsQuery,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../lib/firebase';

function formatIsoDurationToTimestamp(iso) {
  // ISO 8601 duration like PT1H2M3S
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!match) return '';

  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);

  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  if (totalSeconds <= 0) return '';

  const hh = hours > 0 ? String(hours) : '';
  const mm = String(hours > 0 ? minutes.toString().padStart(2, '0') : minutes);
  const ss = String(seconds).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function isoDurationToSeconds(iso) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  const totalSeconds = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(totalSeconds) ? totalSeconds : 0;
}

async function fetchJsonWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function postJsonWithTimeout(url, body, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function aiParseSongForLyrics({ title, author }) {
  let res;
  try {
    // AI calls can be slow / rate-limited; use a slightly larger timeout.
    res = await postJsonWithTimeout('/api/ai/parse-song', { title, author }, 25000);
  } catch (e) {
    const msg = (e && typeof e.message === 'string' && e.message) ? e.message : '';
    const name = (e && typeof e.name === 'string') ? e.name : '';
    const isAbort = name === 'AbortError' || /aborted/i.test(msg);
    if (isAbort) {
      throw new Error('AI parse-song timeout：後端回應太久（可稍後再試，或檢查後端/AI 是否限流）');
    }
    throw new Error(`AI parse-song failed: 無法連線到後端 /api（請確認 server 已啟動在 http://localhost:3001）${msg ? `: ${msg}` : ''}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 422) {
      throw new Error('AI 解析沒有回傳可用的歌名，請改用手動輸入歌名/關鍵字');
    }
    throw new Error(`AI parse-song failed: ${res.status} ${text}`);
  }
  const json = await res.json().catch(() => null);
  return {
    trackName: typeof json?.trackName === 'string' ? json.trackName : '',
    artistName: typeof json?.artistName === 'string' ? json.artistName : '',
    model: json?.model,
    raw: typeof json?.raw === 'string' ? json.raw : '',
  };
}

function normalizeYouTubeTitleForLyrics(title) {
  if (!title) return '';
  // Keep it conservative; just remove common bracketed suffixes.
  return String(title)
    .replace(/\s*[\[\(（【].*?[\]\)）】]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeYouTubeAuthorForLyrics(author) {
  if (!author) return '';
  return String(author).replace(/\s*-\s*Topic\s*$/i, '').trim();
}

function preferCjkTitleIfPresent(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const hasCjk = /[\u4e00-\u9fff]/u.test(s);
  if (!hasCjk) return s;
  // Keep CJK characters plus common separators/spaces; drop English subtitle/translation.
  const cjkOnly = s
    .replace(/[^\u4e00-\u9fff\s·・．。\-—–]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Prefer a single contiguous CJK run if possible.
  const run = cjkOnly.match(/[\u4e00-\u9fff]{2,32}/u);
  return run && run[0] ? run[0].trim() : (cjkOnly || s);
}

// Note: We intentionally avoid heuristic parsing of YouTube titles for lyrics search.
// Lyrics search is restricted to either manual input or AI-parsed results.

async function lrclibSearch({ trackName, artistName }) {
  const url = new URL('https://lrclib.net/api/search');
  if (trackName) url.searchParams.set('track_name', trackName);
  if (artistName) url.searchParams.set('artist_name', artistName);

  const res = await fetchJsonWithTimeout(url, 12000);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LRCLIB search failed: ${res.status} ${text}`);
  }

  const json = await res.json().catch(() => null);
  return {
    url: url.toString(),
    list: Array.isArray(json) ? json : [],
  };
}

function pickBestLrclibRecord(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const withSynced = list.find((it) => typeof it?.syncedLyrics === 'string' && it.syncedLyrics.trim());
  if (withSynced) return withSynced;
  const withPlain = list.find((it) => typeof it?.plainLyrics === 'string' && it.plainLyrics.trim());
  if (withPlain) return withPlain;
  return null;
}

async function youtubeTrendingMostPopular(regionCode = 'TW', pageToken = null) {
  const apiKey = import.meta.env.VITE_YT_API_KEY;
  if (!apiKey) {
    throw new Error('Missing VITE_YT_API_KEY');
  }

  const url = new URL('https://www.googleapis.com/youtube/v3/videos');
  url.searchParams.set('part', 'snippet,contentDetails');
  url.searchParams.set('chart', 'mostPopular');
  // Music category only (avoid news/sports/etc.)
  url.searchParams.set('videoCategoryId', '10');
  // Fetch a bit more to compensate filtering (live/unknown duration)
  url.searchParams.set('maxResults', '20');
  url.searchParams.set('regionCode', regionCode);
  url.searchParams.set('key', apiKey);
  if (pageToken) {
    url.searchParams.set('pageToken', pageToken);
  }

  const res = await fetchJsonWithTimeout(url, 12000);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`YouTube trending failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  const items = Array.isArray(json.items) ? json.items : [];

  const videos = items.map((it) => {
    const snippet = it?.snippet;
    const thumb =
      snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.default?.url || '';
    const iso = it?.contentDetails?.duration;
    return {
      id: it?.id,
      title: snippet?.title || 'Unknown title',
      thumbnail: thumb,
      duration: formatIsoDurationToTimestamp(iso),
      _durationSeconds: isoDurationToSeconds(iso),
      author: snippet?.channelTitle || 'Unknown',
      _live: snippet?.liveBroadcastContent && snippet.liveBroadcastContent !== 'none',
    };
  })
    .filter((v) => v?.id)
    .filter((v) => !v._live)
    .filter((v) => v._durationSeconds > 0)
    .map(({ _durationSeconds, _live, ...rest }) => rest);

  return {
    videos,
    nextPageToken: json?.nextPageToken || null,
  };
}

async function youtubeSearch(queryText, pageToken = null) {
  const apiKey = import.meta.env.VITE_YT_API_KEY;
  if (!apiKey) {
    throw new Error('Missing VITE_YT_API_KEY');
  }

  const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
  searchUrl.searchParams.set('part', 'snippet');
  searchUrl.searchParams.set('type', 'video');
  searchUrl.searchParams.set('maxResults', '10');
  searchUrl.searchParams.set('q', queryText);
  searchUrl.searchParams.set('key', apiKey);
  if (pageToken) {
    searchUrl.searchParams.set('pageToken', pageToken);
  }

  const searchRes = await fetchJsonWithTimeout(searchUrl, 12000);
  if (!searchRes.ok) {
    const text = await searchRes.text().catch(() => '');
    throw new Error(`YouTube search failed: ${searchRes.status} ${text}`);
  }
  const searchJson = await searchRes.json();
  const items = Array.isArray(searchJson.items) ? searchJson.items : [];
  const videoIds = items.map((it) => it?.id?.videoId).filter(Boolean);
  const snippetById = new Map(
    items
      .filter((it) => it?.id?.videoId)
      .map((it) => [it.id.videoId, it.snippet])
  );

  if (videoIds.length === 0) return [];

  const videosUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
  videosUrl.searchParams.set('part', 'contentDetails');
  videosUrl.searchParams.set('id', videoIds.join(','));
  videosUrl.searchParams.set('key', apiKey);

  const videosRes = await fetchJsonWithTimeout(videosUrl, 12000);
  if (!videosRes.ok) {
    const text = await videosRes.text().catch(() => '');
    throw new Error(`YouTube videos fetch failed: ${videosRes.status} ${text}`);
  }
  const videosJson = await videosRes.json();
  const durationsById = new Map(
    (videosJson.items || []).map((it) => [it.id, it?.contentDetails?.duration])
  );

  const videos = videoIds.map((id) => {
    const snippet = snippetById.get(id);
    const thumb = snippet?.thumbnails?.medium?.url || snippet?.thumbnails?.default?.url || '';
    return {
      id,
      title: snippet?.title || 'Unknown title',
      thumbnail: thumb,
      duration: formatIsoDurationToTimestamp(durationsById.get(id)),
      author: snippet?.channelTitle || 'Unknown',
    };
  });

  return {
    videos,
    nextPageToken: searchJson?.nextPageToken || null,
  };
}

function SortableItem(props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: props.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    touchAction: 'none',
  };

  return (
    <li ref={setNodeRef} style={style} {...attributes} {...listeners} className="queue-item">
      {props.children}
    </li>
  );
}

function Room({ roomId, onLeave }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchPageIndex, setSearchPageIndex] = useState(0);
  const [searchPageTokens, setSearchPageTokens] = useState([null]);
  const [searchNextToken, setSearchNextToken] = useState(null);
  const [trending, setTrending] = useState([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState('');
  const [trendingOpen, setTrendingOpen] = useState(false);
  const [trendingPageIndex, setTrendingPageIndex] = useState(0);
  const [trendingPageTokens, setTrendingPageTokens] = useState([null]);
  const [trendingNextToken, setTrendingNextToken] = useState(null);
  const [queue, setQueue] = useState([]);
  const [volume, setVolume] = useState(100);
  const [showPlayer, setShowPlayer] = useState(false);
  const [currentVideo, setCurrentVideo] = useState(null);
  const [roomMuted, setRoomMuted] = useState(false);
  const playerRef = useRef(null);
  const lastAppliedReplayCommandIdRef = useRef(null);
  const [roomReplayCommandId, setRoomReplayCommandId] = useState(null);

  const [showLyricsModal, setShowLyricsModal] = useState(false);
  const [lyricsText, setLyricsText] = useState('');
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricsError, setLyricsError] = useState('');
  const [lyricsMeta, setLyricsMeta] = useState(null);
  const [lyricsRequestUrl, setLyricsRequestUrl] = useState('');
  const [lyricsManualTrackName, setLyricsManualTrackName] = useState('');
  const [lyricsOverrideTrackName, setLyricsOverrideTrackName] = useState('');
  const [lyricsSearchDebug, setLyricsSearchDebug] = useState({
    trackName: '',
    artistName: '',
    source: '',
  });
  const [lyricsAiDebug, setLyricsAiDebug] = useState({
    status: 'idle',
    trackName: '',
    artistName: '',
    model: '',
    error: '',
    raw: '',
  });
  const lyricsCacheRef = useRef(new Map());
  const lyricsAiParseCacheRef = useRef(new Map());

  const roomRef = doc(db, 'rooms', roomId);
  const queueColRef = collection(db, 'rooms', roomId, 'queue');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const loadTrending = async (opts = {}) => {
    const { reset = false, pageIndex = trendingPageIndex } = opts;
    const pageToken = trendingPageTokens[pageIndex] || null;
    setTrendingLoading(true);
    setTrendingError('');
    try {
      const { videos, nextPageToken } = await youtubeTrendingMostPopular('TW', pageToken);
      setTrending(videos);
      setTrendingNextToken(nextPageToken || null);
    } catch (e) {
      console.error(e);
      setTrending([]);
      setTrendingNextToken(null);
      setTrendingError('熱門清單載入失敗（請檢查 VITE_YT_API_KEY 或網路）');
      if (reset) {
        setTrendingPageIndex(0);
        setTrendingPageTokens([null]);
      }
    } finally {
      setTrendingLoading(false);
    }
  };

  const loadSearch = async (opts = {}) => {
    const { reset = false, pageIndex = searchPageIndex, term = searchTerm } = opts;
    const pageToken = searchPageTokens[pageIndex] || null;
    if (!term) {
      setResults([]);
      setSearchNextToken(null);
      return;
    }

    setLoading(true);
    setSearchError('');
    try {
      const { videos, nextPageToken } = await youtubeSearch(term, pageToken);
      setResults(videos);
      setSearchNextToken(nextPageToken || null);
    } catch (e) {
      console.error(e);
      setResults([]);
      setSearchNextToken(null);
      setSearchError('Search failed (check VITE_YT_API_KEY)');
      if (reset) {
        setSearchPageIndex(0);
        setSearchPageTokens([null]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Ensure room exists
    setDoc(
      roomRef,
      { createdAt: serverTimestamp(), updatedAt: serverTimestamp(), volume: 100 },
      { merge: true }
    ).catch(() => {});

    // Trending first page
    setTrendingPageIndex(0);
    setTrendingPageTokens([null]);
    setTrendingNextToken(null);
    loadTrending({ reset: true, pageIndex: 0 });

    const unsubRoom = onSnapshot(roomRef, (snap) => {
      const data = snap.data();
      if (!data) return;
      if (typeof data.volume === 'number') {
        setVolume(data.volume);
        if (playerRef.current) {
          playerRef.current.setVolume(data.volume);
        }
      }

      // Room-wide mute state (for remote control)
      if (typeof data.muted === 'boolean') {
        setRoomMuted(data.muted);
      } else {
        setRoomMuted(false);
      }

      if (data.replayCommandId) {
        setRoomReplayCommandId(data.replayCommandId);
      }
    });

    const qRef = fsQuery(queueColRef, orderBy('order', 'asc'));
    const unsubQueue = onSnapshot(qRef, (snap) => {
      const newQueue = snap.docs.map((d) => ({ uuid: d.id, ...d.data() }));
      setQueue(newQueue);
      if (newQueue.length > 0) setCurrentVideo(newQueue[0]);
      else setCurrentVideo(null);
    });

    return () => {
      unsubRoom();
      unsubQueue();
    };
  }, [roomId]);

  useEffect(() => {
    // Load search results when term/page changes
    loadSearch({ pageIndex: searchPageIndex, term: searchTerm });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchTerm, searchPageIndex]);

  useEffect(() => {
    // Load trending when paging
    loadTrending({ pageIndex: trendingPageIndex });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendingPageIndex]);

  const handleSearch = async (e) => {
    e.preventDefault();
    const term = searchQuery.trim();
    if (!term) return;
    setSearchTerm(term);
    setSearchPageIndex(0);
    setSearchPageTokens([null]);
    setSearchNextToken(null);
  };

  const addToQueue = async (video, isTop = false) => {
    try {
      const snap = await getDocs(fsQuery(queueColRef, orderBy('order', 'asc')));
      const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const lastOrder = items.length === 0 ? -1 : (items[items.length - 1].order ?? items.length - 1);

      const newDocRef = doc(queueColRef);
      const order = isTop && items.length > 0 ? (items[0].order ?? 0) + 0.5 : lastOrder + 1;
      await setDoc(newDocRef, {
        id: video.id,
        title: video.title,
        thumbnail: video.thumbnail,
        duration: video.duration,
        author: video.author,
        createdAt: serverTimestamp(),
        order,
      });

      if (isTop) {
        await normalizeQueue();
      }
    } catch (e) {
      console.error(e);
      alert('Failed to add song');
    }
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseInt(e.target.value, 10);
    setVolume(newVolume);
    updateDoc(roomRef, { volume: newVolume, updatedAt: serverTimestamp() }).catch(() => {});
  };

  const normalizeQueue = async () => {
    const snap = await getDocs(fsQuery(queueColRef, orderBy('order', 'asc')));
    const docs = snap.docs;
    if (docs.length === 0) return;
    const batch = writeBatch(db);
    docs.forEach((d, idx) => {
      batch.update(d.ref, { order: idx });
    });
    await batch.commit();
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (active.id !== over.id) {
      const oldIndex = queue.findIndex((item) => item.uuid === active.id);
      const newIndex = queue.findIndex((item) => item.uuid === over.id);
      if (oldIndex === 0 || newIndex === 0) return;
      const newQueue = arrayMove(queue, oldIndex, newIndex);
      setQueue(newQueue);

      // Persist reorder (re-number orders; keep index 0 as playing)
      const batch = writeBatch(db);
      newQueue.forEach((song, idx) => {
        batch.update(doc(queueColRef, song.uuid), { order: idx });
      });
      batch.commit().catch((e) => console.error(e));
    }
  };

  const onPlayerReady = (event) => {
    playerRef.current = event.target;
    playerRef.current.setVolume(volume);
    try {
      if (roomMuted) playerRef.current.mute();
      else playerRef.current.unMute();
    } catch (e) {
      console.error(e);
    }
  };

  // Apply room mute state whenever player becomes available or state changes.
  useEffect(() => {
    if (!showPlayer) return;
    const player = playerRef.current;
    if (!player) return;
    try {
      if (roomMuted) player.mute();
      else player.unMute();
    } catch (e) {
      console.error(e);
    }
  }, [showPlayer, roomMuted]);

  // Apply replay commands on the host player.
  useEffect(() => {
    if (!showPlayer) return;
    const player = playerRef.current;
    if (!player) return;
    if (!roomReplayCommandId) return;
    if (roomReplayCommandId === lastAppliedReplayCommandIdRef.current) return;
    lastAppliedReplayCommandIdRef.current = roomReplayCommandId;
    try {
      player.seekTo(0, true);
      player.playVideo();
    } catch (e) {
      console.error(e);
    }
  }, [showPlayer, roomReplayCommandId]);

  const onPlayerEnd = () => {
    advanceSong().catch(() => {});
  };

  const onPlayerError = () => {
    advanceSong().catch(() => {});
  };

  const loadLyricsForCurrent = async (opts = {}) => {
    const { force = false, overrideTrackName = '' } = opts;
    if (!currentVideo?.id) {
      setLyricsText('');
      setLyricsError('');
      setLyricsMeta(null);
      setLyricsRequestUrl('');
      setLyricsSearchDebug({ trackName: '', artistName: '', source: '' });
      setLyricsAiDebug({ status: 'idle', trackName: '', artistName: '', model: '', error: '', raw: '' });
      return;
    }

    const cacheKey = currentVideo.id;
    if (!force && lyricsCacheRef.current.has(cacheKey)) {
      const cached = lyricsCacheRef.current.get(cacheKey);
      setLyricsText(cached?.text || '');
      setLyricsMeta(cached?.meta || null);
      setLyricsError(cached?.error || '');
      setLyricsRequestUrl(cached?.requestUrl || '');
      setLyricsSearchDebug(cached?.searchDebug || { trackName: '', artistName: '', source: '' });
      const cachedAi = lyricsAiParseCacheRef.current.get(cacheKey);
      if (cachedAi?.trackName || cachedAi?.artistName) {
        setLyricsAiDebug({
          status: 'ok',
          trackName: cachedAi.trackName || '',
          artistName: cachedAi.artistName || '',
          model: cachedAi.model || '',
          error: '',
          raw: cachedAi.raw || '',
        });
      } else {
        setLyricsAiDebug({ status: 'idle', trackName: '', artistName: '', model: '', error: '', raw: '' });
      }
      return;
    }

    setLyricsLoading(true);
    setLyricsError('');
    setLyricsMeta(null);
    setLyricsRequestUrl('');
    setLyricsSearchDebug({ trackName: '', artistName: '', source: '' });
    setLyricsAiDebug((prev) => ({ ...prev, status: 'idle', error: '' }));

    const normalizedAuthor = normalizeYouTubeAuthorForLyrics(currentVideo.author);

    const manualTitle = normalizeYouTubeTitleForLyrics(overrideTrackName);

    // Trigger rule:
    // - If user provides manualTitle, NEVER call AI for this fetch.
    // - Otherwise, we may call AI (and cache) to guess a track name.
    let aiParsed = null;
    if (manualTitle) {
      setLyricsAiDebug({ status: 'skipped', trackName: '', artistName: '', model: '', error: '', raw: '' });
    } else {
      aiParsed = lyricsAiParseCacheRef.current.get(cacheKey) || null;
      if (!aiParsed || force) {
        try {
          setLyricsAiDebug({ status: 'loading', trackName: '', artistName: '', model: '', error: '', raw: '' });
          const out = await aiParseSongForLyrics({ title: currentVideo.title || '', author: currentVideo.author || '' });
          aiParsed = {
            trackName: preferCjkTitleIfPresent(normalizeYouTubeTitleForLyrics(out?.trackName || '')),
            artistName: '',
            model: out?.model || '',
            raw: out?.raw || '',
          };
          lyricsAiParseCacheRef.current.set(cacheKey, aiParsed);
          setLyricsAiDebug({
            status: 'ok',
            trackName: aiParsed.trackName || '',
            artistName: aiParsed.artistName || '',
            model: aiParsed.model || '',
            error: '',
            raw: aiParsed.raw || '',
          });
        } catch (e) {
          const message = (e && typeof e.message === 'string' && e.message) ? e.message : 'AI 解析失敗';
          setLyricsAiDebug({ status: 'error', trackName: '', artistName: '', model: '', error: message, raw: '' });
          aiParsed = lyricsAiParseCacheRef.current.get(cacheKey) || null;
        }
      } else if (aiParsed?.trackName || aiParsed?.artistName) {
        setLyricsAiDebug({
          status: 'ok',
          trackName: aiParsed.trackName || '',
          artistName: aiParsed.artistName || '',
          model: aiParsed.model || '',
          error: '',
          raw: aiParsed.raw || '',
        });
      }
    }

    const candidateQueries = [];
    // 1) Manual override (track name)
    if (manualTitle) {
      candidateQueries.push({ trackName: manualTitle, artistName: '', source: 'manual(track-only)' });
    }

    // 2) AI-parsed best guess
    if (aiParsed?.trackName) {
      // Prefer track-only (user preference). If artist exists, also try it as a narrower query.
      candidateQueries.push({ trackName: aiParsed.trackName, artistName: '', source: 'ai(track-only)' });
    }

    // If neither manual nor AI provides a track name, stop early.
    if (candidateQueries.length === 0) {
      const err = '請先手動輸入歌名/關鍵字，或等待 AI 解析出歌名後再搜尋。';
      setLyricsText('');
      setLyricsError(err);
      setLyricsMeta(null);
      setLyricsRequestUrl('');
      setLyricsSearchDebug({ trackName: '', artistName: '', source: '' });
      lyricsCacheRef.current.set(cacheKey, {
        text: '',
        meta: null,
        error: err,
        requestUrl: '',
        searchDebug: { trackName: '', artistName: '', source: '' },
      });
      return;
    }

    try {
      let best = null;
      let usedUrl = '';
      let usedQuery = null;
      for (const q of candidateQueries) {
        const { url, list } = await lrclibSearch({ trackName: q.trackName, artistName: q.artistName });
        usedUrl = url;
        usedQuery = { trackName: q.trackName || '', artistName: q.artistName || '', source: q.source || '' };
        best = pickBestLrclibRecord(list);
        if (best) break;
      }

      setLyricsRequestUrl(usedUrl);
      setLyricsSearchDebug(usedQuery || { trackName: '', artistName: '', source: '' });

      if (!best) {
        const err = '找不到歌詞（可嘗試按「重新抓取」或換不同關鍵字）';
        setLyricsText('');
        setLyricsError(err);
        lyricsCacheRef.current.set(cacheKey, {
          text: '',
          meta: null,
          error: err,
          requestUrl: usedUrl,
          searchDebug: usedQuery || { trackName: '', artistName: '', source: '' },
        });
        return;
      }

      const meta = {
        id: best.id ?? null,
        title: best.trackName || normalizedTitle,
        artist: best.artistName || normalizedAuthor,
      };

      const lyrics =
        (typeof best.syncedLyrics === 'string' && best.syncedLyrics.trim())
          ? best.syncedLyrics
          : (typeof best.plainLyrics === 'string' ? best.plainLyrics : '');

      setLyricsText(lyrics);
      setLyricsMeta(meta);
      setLyricsError('');
      lyricsCacheRef.current.set(cacheKey, {
        text: lyrics,
        meta,
        error: '',
        requestUrl: usedUrl,
        searchDebug: usedQuery || { trackName: '', artistName: '', source: '' },
      });
    } catch (e) {
      console.error(e);
      const message =
        '歌詞載入失敗（可能是網路或歌詞服務暫時不可用）。可稍後再試。';
      setLyricsText('');
      setLyricsMeta(null);
      setLyricsError(message);
      lyricsCacheRef.current.set(cacheKey, {
        text: '',
        meta: null,
        error: message,
        requestUrl: '',
        searchDebug: { trackName: '', artistName: '', source: '' },
      });
    } finally {
      setLyricsLoading(false);
    }
  };

  useEffect(() => {
    // Auto load lyrics when the playing song changes.
    setLyricsOverrideTrackName('');
    setLyricsManualTrackName('');
    loadLyricsForCurrent({ force: false }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVideo?.id]);

  const handleManualLyricsSearch = () => {
    if (!currentVideo?.id) return;
    const q = (lyricsManualTrackName || '').trim();
    if (!q) return;
    setLyricsOverrideTrackName(q);
    loadLyricsForCurrent({ force: true, overrideTrackName: q }).catch(() => {});
  };

  const clearManualLyricsSearch = () => {
    setLyricsOverrideTrackName('');
    setLyricsManualTrackName('');
    loadLyricsForCurrent({ force: true, overrideTrackName: '' }).catch(() => {});
  };

  const sendMuted = async (muted) => {
    const muteCommandId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setRoomMuted(muted);
    await setDoc(
      roomRef,
      {
        muted,
        muteCommandId,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  };

  const toggleMute = () => {
    sendMuted(!roomMuted).catch((e) => console.error(e));
  };

  const sendReplay = async () => {
    const replayCommandId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await setDoc(
      roomRef,
      {
        replayCommandId,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  };

  const advanceSong = async () => {
    const firstSnap = await getDocs(fsQuery(queueColRef, orderBy('order', 'asc'), limit(1)));
    if (!firstSnap.empty) {
      await deleteDoc(firstSnap.docs[0].ref);
    }
    await normalizeQueue();
  };

  const playerOpts = {
    height: '390',
    width: '100%',
    playerVars: {
      autoplay: 1,
    },
  };

  return (
    <>
      <div className="container">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0 }}>Room: {roomId}</h2>
        <button onClick={onLeave} style={{ fontSize: '0.8rem', padding: '8px 16px', background: 'rgba(255,0,0,0.2)', borderColor: 'rgba(255,0,0,0.3)' }}>Exit</button>
      </div>

      <div className="control-panel" style={{ marginBottom: '20px', padding: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', margin: 0 }}>
          <input 
            type="checkbox" 
            checked={showPlayer} 
            onChange={(e) => setShowPlayer(e.target.checked)} 
            style={{ width: '22px', height: '22px', cursor: 'pointer' }}
          />
          <span style={{ fontWeight: '600', fontSize: '1rem' }}>開啟播放器 (房主模式)</span>
        </label>
      </div>

      {showPlayer && (
        <div className="player-wrapper" style={{ marginBottom: '20px' }}>
          {currentVideo ? (
            <YouTube
              videoId={currentVideo.id}
              opts={playerOpts}
              onReady={onPlayerReady}
              onEnd={onPlayerEnd}
              onError={onPlayerError}
            />
          ) : (
            <div style={{ height: '300px', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <h3>Waiting for songs... 🎵</h3>
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="control-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
          <label style={{ fontWeight: '600', fontSize: '0.9rem', opacity: 0.8 }}>音量控制</label>
          <span style={{ fontSize: '0.9rem', fontWeight: 'bold', color: 'var(--accent-color)' }}>{volume}%</span>
        </div>
        <input 
          type="range" 
          min="0" 
          max="100" 
          value={volume} 
          onChange={handleVolumeChange} 
          style={{ marginBottom: '10px' }}
        />

        <div className="control-grid">
          <button
            type="button"
            className="control-btn-circle"
            onClick={toggleMute}
            disabled={!currentVideo}
            title={roomMuted ? '取消靜音' : '靜音'}
          >
            {roomMuted ? '🔊' : '🔇'}
          </button>

          <button
            type="button"
            className="control-btn-circle"
            onClick={() => sendReplay().catch(() => {})}
            disabled={!currentVideo}
            title="重播"
          >
            🔁
          </button>

          <button 
            type="button"
            className="control-btn-circle skip"
            onClick={() => advanceSong().catch(() => {})}
            disabled={!currentVideo}
            title="切歌"
          >
            ⏭️
          </button>

          <button
            type="button"
            className="control-btn lyrics"
            onClick={() => setShowLyricsModal(true)}
          >
            🎵 顯示歌詞
          </button>
        </div>
      </div>

      {/* Search */}
      {/* Trending */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
          <h3 style={{ margin: 0 }}>熱門歌曲（亞洲）</h3>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              style={{ margin: 0, padding: '6px 10px', fontSize: '0.85rem' }}
              onClick={() => setTrendingOpen((v) => !v)}
            >
              {trendingOpen ? '收起' : '展開'}
            </button>
            <button
              style={{ margin: 0, padding: '6px 10px', fontSize: '0.85rem' }}
              onClick={() => {
                setTrendingPageIndex(0);
                setTrendingPageTokens([null]);
                setTrendingNextToken(null);
                loadTrending({ reset: true, pageIndex: 0 });
              }}
              disabled={trendingLoading}
            >
              {trendingLoading ? '...' : '更新'}
            </button>
          </div>
        </div>

        {trendingError ? (
          <div style={{ color: 'var(--warning-color)', textAlign: 'left', marginBottom: '8px', fontSize: '0.9rem' }}>
            {trendingError}
          </div>
        ) : null}

        {trendingOpen ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                第 {trendingPageIndex + 1} 頁
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  style={{ margin: 0, padding: '6px 10px', fontSize: '0.85rem' }}
                  onClick={() => setTrendingPageIndex((i) => Math.max(0, i - 1))}
                  disabled={trendingLoading || trendingPageIndex === 0}
                >
                  上一頁
                </button>
                <button
                  type="button"
                  style={{ margin: 0, padding: '6px 10px', fontSize: '0.85rem' }}
                  onClick={() => {
                    if (!trendingNextToken) return;
                    const nextIndex = trendingPageIndex + 1;
                    setTrendingPageTokens((prev) => {
                      const next = prev.slice();
                      if (next[nextIndex] == null) next[nextIndex] = trendingNextToken;
                      return next;
                    });
                    setTrendingPageIndex(nextIndex);
                  }}
                  disabled={trendingLoading || !trendingNextToken}
                >
                  下一頁
                </button>
              </div>
            </div>

            <div className="results">
              {trending.map((video) => (
                <div key={video.id} className="video-item">
                  <img src={video.thumbnail} alt={video.title} />
                  <div className="video-info">
                    <div className="video-title">{video.title}</div>
                    <div className="video-meta">{video.author} • {video.duration}</div>
                  </div>
                  <div className="flex-col">
                    <button onClick={() => addToQueue(video)} className="btn-primary" style={{ margin: 0 }}>+</button>
                    <button onClick={() => addToQueue(video, true)} style={{ margin: 0, backgroundColor: 'var(--warning-color)', color: 'black' }}>Top</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>

      <form onSubmit={handleSearch} style={{ marginBottom: '20px', display: 'flex', gap: '10px' }}>
        <input 
          type="text" 
          value={searchQuery} 
          onChange={(e) => setSearchQuery(e.target.value)} 
          placeholder="Search YouTube..." 
        />
        <button type="submit" disabled={loading} className="btn-primary" style={{ margin: 0, minWidth: '80px' }}>
          {loading ? '...' : '🔍'}
        </button>
      </form>

      {searchError ? (
        <div style={{ color: 'var(--warning-color)', textAlign: 'left', marginBottom: '8px', fontSize: '0.9rem' }}>
          {searchError}
        </div>
      ) : null}

      {/* Results */}
      <div className="results">
        {results.map((video) => (
          <div key={video.id} className="video-item">
            <img src={video.thumbnail} alt={video.title} />
            <div className="video-info">
              <div className="video-title">{video.title}</div>
              <div className="video-meta">{video.author} • {video.duration}</div>
            </div>
            <div className="flex-col">
              <button onClick={() => addToQueue(video)} className="btn-primary" style={{ margin: 0 }}>+</button>
              <button onClick={() => addToQueue(video, true)} style={{ margin: 0, backgroundColor: 'var(--warning-color)', color: 'black' }}>Top</button>
            </div>
          </div>
        ))}
      </div>

      {results.length > 0 ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px', marginBottom: '8px' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            搜尋結果第 {searchPageIndex + 1} 頁
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              style={{ margin: 0, padding: '6px 10px', fontSize: '0.85rem' }}
              onClick={() => setSearchPageIndex((i) => Math.max(0, i - 1))}
              disabled={loading || searchPageIndex === 0}
            >
              上一頁
            </button>
            <button
              type="button"
              style={{ margin: 0, padding: '6px 10px', fontSize: '0.85rem' }}
              onClick={() => {
                if (!searchNextToken) return;
                const nextIndex = searchPageIndex + 1;
                setSearchPageTokens((prev) => {
                  const next = prev.slice();
                  if (next[nextIndex] == null) next[nextIndex] = searchNextToken;
                  return next;
                });
                setSearchPageIndex(nextIndex);
              }}
              disabled={loading || !searchNextToken}
            >
              下一頁
            </button>
          </div>
        </div>
      ) : null}

      <hr style={{ margin: '30px 0', borderColor: '#444' }} />

      {/* Queue */}
      <h3>Current Queue ({queue.length})</h3>
      
      {queue.length > 0 && (
        <div className="queue-item playing">
           <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
             <span className="queue-index">▶</span>
             <span style={{ flex: 1, textAlign: 'left', fontWeight: 'bold' }}>{queue[0].title}</span>
           </div>
        </div>
      )}

      <DndContext 
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext 
          items={queue.slice(1).map(item => item.uuid)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="queue-list">
            {queue.slice(1).map((song, index) => (
              <SortableItem key={song.uuid} id={song.uuid}>
                <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                  <span className="drag-handle">☰</span>
                  <span className="queue-index">{index + 1}.</span>
                  <span style={{ flex: 1, textAlign: 'left', fontSize: '0.9rem' }}>{song.title}</span>
                  <div style={{ display: 'flex', gap: '5px' }}>
                    <button 
                      onClick={async () => {
                        try {
                          const snap = await getDocs(fsQuery(queueColRef, orderBy('order', 'asc')));
                          const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                          if (docs.length < 2) return;

                          const playing = docs[0];
                          const rest = docs.slice(1);
                          const idx = rest.findIndex((d) => d.id === song.uuid);
                          if (idx < 0) return;
                          const [picked] = rest.splice(idx, 1);
                          const normalized = [playing, picked, ...rest];

                          const batch = writeBatch(db);
                          normalized.forEach((item, i) => {
                            batch.update(doc(queueColRef, item.id), { order: i });
                          });
                          await batch.commit();
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      style={{ backgroundColor: 'var(--warning-color)', color: 'black', padding: '5px 10px', fontSize: '0.8rem', margin: 0 }}
                    >
                      Top
                    </button>
                    <button 
                      onClick={() => deleteDoc(doc(queueColRef, song.uuid)).catch(() => {})}
                      onPointerDown={(e) => e.stopPropagation()}
                      style={{ backgroundColor: '#555', padding: '5px 10px', fontSize: '0.8rem', margin: 0 }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </SortableItem>
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>

    {/* Lyrics Modal - Moved outside container to fix stacking and click issues */}
    {showLyricsModal && (
      <div className="glass-overlay" onClick={() => setShowLyricsModal(false)}>
        <div className="glass-modal" onClick={(e) => e.stopPropagation()}>
          <div className="glass-header">
            <h3 style={{ margin: 0, fontSize: '1.4rem' }}>🎵 歌詞</h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                onClick={() => loadLyricsForCurrent({ force: true, overrideTrackName: lyricsOverrideTrackName || '' }).catch(() => {})}
                disabled={!currentVideo || lyricsLoading}
                style={{ margin: 0, padding: '8px 16px', fontSize: '0.85rem', background: 'rgba(255,255,255,0.1)' }}
              >
                {lyricsLoading ? '...' : '重新抓取'}
              </button>
              <button
                onClick={() => setShowLyricsModal(false)}
                style={{
                  backgroundColor: 'rgba(255,255,255,0.1)',
                  border: 'none',
                  fontSize: '1.2rem',
                  color: '#fff',
                  cursor: 'pointer',
                  padding: '8px 12px',
                  borderRadius: '50%',
                  margin: 0,
                  width: '40px',
                  height: '40px'
                }}
              >
                ✕
              </button>
            </div>
          </div>

          <div className="glass-content">
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '16px' }}>
              <input
                type="text"
                className="glass-input"
                value={lyricsManualTrackName}
                onChange={(e) => setLyricsManualTrackName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleManualLyricsSearch();
                  }
                }}
                placeholder="手動輸入歌名/關鍵字"
                disabled={!currentVideo || lyricsLoading}
                style={{ flex: 1, background: 'rgba(255,255,255,0.05)' }}
              />
              <button
                type="button"
                onClick={handleManualLyricsSearch}
                disabled={!currentVideo || lyricsLoading || !(lyricsManualTrackName || '').trim()}
                style={{ margin: 0, padding: '10px 16px', fontSize: '0.85rem', whiteSpace: 'nowrap', background: 'var(--accent-color)', color: 'white', border: 'none' }}
              >
                搜尋
              </button>
              <button
                type="button"
                onClick={clearManualLyricsSearch}
                disabled={!currentVideo || lyricsLoading || !lyricsOverrideTrackName}
                style={{ margin: 0, padding: '10px 16px', fontSize: '0.85rem', whiteSpace: 'nowrap', background: 'rgba(255,255,255,0.1)' }}
              >
                清除
              </button>
            </div>

            {lyricsOverrideTrackName && (
              <div style={{ color: 'var(--accent-color)', fontSize: '0.85rem', marginBottom: '12px', fontWeight: '600', textShadow: '0 0 10px rgba(62, 166, 255, 0.3)' }}>
                🔍 目前搜尋：{lyricsOverrideTrackName}
              </div>
            )}

            <div style={{ 
              background: 'rgba(255,255,255,0.05)', 
              padding: '16px', 
              borderRadius: '16px', 
              fontSize: '0.85rem', 
              marginBottom: '20px',
              border: '1px solid rgba(255,255,255,0.1)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.9 }}>
                <span style={{ fontWeight: '600' }}>AI 解析狀態：</span>
                <span>
                  {lyricsAiDebug.status === 'loading' ? '⏳ 解析中…' : ''}
                  {lyricsAiDebug.status === 'idle' ? '💤 尚未解析' : ''}
                  {lyricsAiDebug.status === 'skipped' ? '⏩ 已跳過' : ''}
                  {lyricsAiDebug.status === 'ok' ? '✅ 已完成' : ''}
                  {lyricsAiDebug.status === 'error' ? '❌ 失敗' : ''}
                  {lyricsAiDebug.model && ` (${lyricsAiDebug.model})`}
                </span>
              </div>
              {lyricsAiDebug.trackName && (
                <div style={{ marginTop: '6px', fontWeight: 'bold', color: '#fff' }}>
                  AI 建議歌名：{lyricsAiDebug.trackName}
                </div>
              )}
              {lyricsAiDebug.raw && (
                <details style={{ marginTop: '10px' }}>
                  <summary style={{ cursor: 'pointer', fontSize: '0.75rem', opacity: 0.7, color: 'var(--accent-color)' }}>查看 AI 原始輸出</summary>
                  <pre style={{ 
                    margin: '8px 0 0 0', 
                    whiteSpace: 'pre-wrap', 
                    fontSize: '0.75rem', 
                    opacity: 0.9, 
                    backgroundColor: 'rgba(0,0,0,0.2)', 
                    padding: '10px', 
                    borderRadius: '10px',
                    border: '1px solid rgba(255,255,255,0.05)',
                    color: '#ccc'
                  }}>
                    {lyricsAiDebug.raw}
                  </pre>
                </details>
              )}
              {lyricsAiDebug.error && (
                <div style={{ color: '#ff5252', marginTop: '6px', fontWeight: '600' }}>
                  {lyricsAiDebug.error}
                </div>
              )}
            </div>

            {(lyricsSearchDebug.trackName || lyricsSearchDebug.artistName || lyricsSearchDebug.source) && (
              <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.8rem', marginBottom: '20px' }}>
                🔍 本次查詢：
                {lyricsSearchDebug.source ? `[${lyricsSearchDebug.source}] ` : ''}
                <span style={{ color: '#fff', fontWeight: '600' }}>{lyricsSearchDebug.trackName || '—'}</span>
                {lyricsSearchDebug.artistName ? ` / ${lyricsSearchDebug.artistName}` : ''}
              </div>
            )}

            {currentVideo && (
              <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: 'white' }}>
                  {lyricsMeta?.title || normalizeYouTubeTitleForLyrics(currentVideo.title)}
                </div>
                <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  {lyricsMeta?.artist || normalizeYouTubeAuthorForLyrics(currentVideo.author)}
                </div>
              </div>
            )}

            <div style={{ 
              textAlign: 'center',
              lineHeight: 1.8,
              fontSize: '1.1rem',
              color: '#eee',
              padding: '0 10px'
            }}>
              {lyricsLoading ? (
                <div style={{ padding: '40px 0', opacity: 0.5 }}>載入中…</div>
              ) : lyricsText ? (
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>
                  {lyricsText}
                </pre>
              ) : (
                <div style={{ padding: '40px 0', opacity: 0.5 }}>
                  {lyricsError || '尚未取得歌詞'}
                </div>
              )}
            </div>
          </div>

          {lyricsRequestUrl && (
            <div className="glass-footer" style={{ textAlign: 'center', fontSize: '0.8rem' }}>
              <a href={lyricsRequestUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-color)', textDecoration: 'none' }}>
                🔗 歌詞來源 API 連結
              </a>
            </div>
          )}
        </div>
      </div>
    )}
  </>
);
}

export default Room;
