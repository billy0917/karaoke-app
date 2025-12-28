import React, { useState, useEffect } from 'react';
import axios from 'axios';
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

function Remote({ socket }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState([]);
  const [volume, setVolume] = useState(100);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    socket.emit('requestQueue');
    socket.on('queueUpdated', (newQueue) => {
      setQueue(newQueue);
    });
    return () => {
      socket.off('queueUpdated');
    };
  }, [socket]);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    try {
      const res = await axios.get(`/api/search?q=${encodeURIComponent(query)}`);
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
    alert(`Added: ${video.title} ${isTop ? '(Top)' : ''}`);
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
      
      // Don't allow moving the currently playing song (index 0)
      if (oldIndex === 0 || newIndex === 0) return;

      const newQueue = arrayMove(queue, oldIndex, newIndex);
      setQueue(newQueue); // Optimistic update
      socket.emit('reorderQueue', newQueue);
    }
  };

  return (
    <div className="container">
      <h2>Remote Control 📱</h2>
      
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

export default Remote;
