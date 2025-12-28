import React, { useState, useEffect, useRef } from 'react';
import YouTube from 'react-youtube';

function Player({ socket }) {
  const [queue, setQueue] = useState([]);
  const [currentVideo, setCurrentVideo] = useState(null);
  const playerRef = useRef(null);

  useEffect(() => {
    socket.emit('requestQueue');
    // Listen for queue updates
    socket.on('queueUpdated', (newQueue) => {
      setQueue(newQueue);
      if (newQueue.length > 0) {
        setCurrentVideo(newQueue[0]);
      } else {
        setCurrentVideo(null);
      }
    });

    // Listen for volume changes
    socket.on('volumeChange', (volume) => {
      if (playerRef.current) {
        playerRef.current.setVolume(volume);
      }
    });

    return () => {
      socket.off('queueUpdated');
      socket.off('volumeChange');
    };
  }, [socket]);

  const onReady = (event) => {
    playerRef.current = event.target;
    // Set initial volume if needed, or sync with server state if we stored it
  };

  const onEnd = () => {
    console.log('Video ended');
    socket.emit('songEnded');
  };

  const onError = (e) => {
    console.error('Video error:', e);
    // Skip song on error
    socket.emit('songEnded');
  };

  const opts = {
    height: '500',
    width: '100%',
    playerVars: {
      autoplay: 1,
    },
  };

  return (
    <div className="container">
      <h2 style={{ textAlign: 'left' }}>Now Playing</h2>
      <div className="player-wrapper">
        {currentVideo ? (
          <div>
            <YouTube
              videoId={currentVideo.id}
              opts={opts}
              onReady={onReady}
              onEnd={onEnd}
              onError={onError}
            />
            <div style={{ padding: '20px', textAlign: 'left' }}>
              <h3 style={{ margin: '0 0 10px 0' }}>{currentVideo.title}</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#aaa' }}>{currentVideo.author}</span>
                <button 
                  onClick={() => socket.emit('skipSong')}
                  style={{ backgroundColor: 'var(--warning-color)', color: 'black' }}
                >
                  ⏭️ Skip Song
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ height: '500px', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
            <h2 style={{ fontSize: '3rem', marginBottom: '20px' }}>🎵</h2>
            <h2>Waiting for songs...</h2>
            <p style={{ color: '#666' }}>Scan the QR code or visit the URL to add songs</p>
          </div>
        )}
      </div>

      <div className="queue-section" style={{ textAlign: 'left' }}>
        <h3>Up Next</h3>
        <ul className="queue-list">
          {queue.slice(1).map((song, index) => (
            <li key={song.uuid} className="queue-item">
              <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                <span className="queue-index">{index + 1}.</span>
                <span style={{ flex: 1 }}>{song.title}</span>
                <button 
                  onClick={() => socket.emit('removeSong', song.uuid)}
                  style={{ backgroundColor: '#333', padding: '5px 10px', fontSize: '0.8rem' }}
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
          {queue.length <= 1 && <p style={{ color: '#666', fontStyle: 'italic' }}>Queue is empty</p>}
        </ul>
      </div>
    </div>
  );
}

export default Player;
