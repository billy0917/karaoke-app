import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import YouTube from 'react-youtube';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

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

function Room({ socket, roomId, onLeave }) {
  const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState([]);
  const [volume, setVolume] = useState(100);
  const [showPlayer, setShowPlayer] = useState(false);
  const [currentVideo, setCurrentVideo] = useState(null);
  const playerRef = useRef(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  useEffect(() => {
    // Join the room
    socket.emit('joinRoom', roomId);

    socket.on('queueUpdated', (newQueue) => {
      setQueue(newQueue);
      if (newQueue.length > 0) {
        setCurrentVideo(newQueue[0]);
      } else {
        setCurrentVideo(null);
      }
    });

    socket.on('volumeChange', (vol) => {
      setVolume(vol);
      if (playerRef.current) {
        playerRef.current.setVolume(vol);
      }
    });

    return () => {
      socket.off('queueUpdated');
      socket.off('volumeChange');
    };
  }, [socket, roomId]);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const url = apiBase
        ? `${apiBase}/api/search?q=${encodeURIComponent(query)}`
        : `/api/search?q=${encodeURIComponent(query)}`;

      const res = await axios.get(url);
      setResults(res.data);
    } catch (err) {
      console.error(err);
      alert('Search failed');
    } finally {
      setLoading(false);
    }
  };

  const addToQueue = (video, isTop = false) => {
    socket.emit('addSong', { ...video, isTop });
    setResults([]); 
    setQuery('');
  };

  const handleVolumeChange = (e) => {
    const newVolume = parseInt(e.target.value, 10);
    setVolume(newVolume);
    socket.emit('volumeChange', newVolume);
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (active.id !== over.id) {
      const oldIndex = queue.findIndex((item) => item.uuid === active.id);
      const newIndex = queue.findIndex((item) => item.uuid === over.id);
      if (oldIndex === 0 || newIndex === 0) return;
      const newQueue = arrayMove(queue, oldIndex, newIndex);
      setQueue(newQueue);
      socket.emit('reorderQueue', newQueue);
    }
  };

  const onPlayerReady = (event) => {
    playerRef.current = event.target;
    playerRef.current.setVolume(volume);
  };

  const onPlayerEnd = () => {
    socket.emit('songEnded');
  };

  const onPlayerError = () => {
    socket.emit('songEnded');
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
          onClick={() => socket.emit('skipSong')}
          style={{ width: '100%', marginTop: '15px', backgroundColor: 'var(--warning-color)', color: '#000' }}
        >
          ⏭️ Skip Current Song
        </button>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} style={{ marginBottom: '20px', display: 'flex', gap: '10px' }}>
        <input 
          type="text" 
          value={query} 
          onChange={(e) => setQuery(e.target.value)} 
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
                      onClick={() => socket.emit('pinSong', song.uuid)}
                      onPointerDown={(e) => e.stopPropagation()}
                      style={{ backgroundColor: 'var(--warning-color)', color: 'black', padding: '5px 10px', fontSize: '0.8rem', margin: 0 }}
                    >
                      Top
                    </button>
                    <button 
                      onClick={() => socket.emit('removeSong', song.uuid)}
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
