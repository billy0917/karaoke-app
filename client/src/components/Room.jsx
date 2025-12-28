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

async function youtubeSearch(queryText) {
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

  const searchRes = await fetch(searchUrl);
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

  const videosRes = await fetch(videosUrl);
  if (!videosRes.ok) {
    const text = await videosRes.text().catch(() => '');
    throw new Error(`YouTube videos fetch failed: ${videosRes.status} ${text}`);
  }
  const videosJson = await videosRes.json();
  const durationsById = new Map(
    (videosJson.items || []).map((it) => [it.id, it?.contentDetails?.duration])
  );

  return videoIds.map((id) => {
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
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
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
  const playerRef = useRef(null);

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
    // Load trending when paging
    loadTrending({ pageIndex: trendingPageIndex });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendingPageIndex]);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setLoading(true);
    try {
      const videos = await youtubeSearch(searchQuery.trim());
      setResults(videos);
    } catch (err) {
      console.error(err);
      alert('Search failed (check VITE_YT_API_KEY)');
    } finally {
      setLoading(false);
    }
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
  };

  const onPlayerEnd = () => {
    advanceSong().catch(() => {});
  };

  const onPlayerError = () => {
    advanceSong().catch(() => {});
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
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0 }}>Room: {roomId}</h2>
        <button onClick={onLeave} style={{ backgroundColor: '#333', fontSize: '0.8rem', padding: '5px 10px' }}>Exit</button>
      </div>

      <div style={{ marginBottom: '20px', padding: '10px', backgroundColor: 'var(--surface-color)', borderRadius: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
          <input 
            type="checkbox" 
            checked={showPlayer} 
            onChange={(e) => setShowPlayer(e.target.checked)} 
            style={{ width: '20px', height: '20px' }}
          />
          <span style={{ fontWeight: 'bold' }}>Enable Video Player (Host Mode)</span>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
          <label style={{ fontWeight: 'bold' }}>Volume</label>
          <span>{volume}%</span>
        </div>
        <input 
          type="range" 
          min="0" 
          max="100" 
          value={volume} 
          onChange={handleVolumeChange} 
        />
        <button 
          onClick={() => advanceSong().catch(() => {})}
          style={{ width: '100%', marginTop: '15px', backgroundColor: 'var(--warning-color)', color: '#000' }}
        >
          ⏭️ Skip Current Song
        </button>
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
              type="button"
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
  );
}

export default Room;
