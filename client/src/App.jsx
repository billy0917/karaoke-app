import React, { useState, useEffect } from 'react';
import Room from './components/Room';

function App() {
  const [roomId, setRoomId] = useState(localStorage.getItem('lastRoomId') || '');
  const [joined, setJoined] = useState(false);
  const [inputRoomId, setInputRoomId] = useState('');

  useEffect(() => {
    // If we have a stored room ID, maybe we want to auto-join?
    // For now, let's just pre-fill the input.
    if (roomId) {
      setInputRoomId(roomId);
    }
  }, []);

  const handleJoin = (e) => {
    e.preventDefault();
    if (!inputRoomId.trim()) return;
    
    const id = inputRoomId.trim();
    setRoomId(id);
    setJoined(true);
    localStorage.setItem('lastRoomId', id);
  };

  const handleLeave = () => {
    setJoined(false);
    setRoomId('');
    localStorage.removeItem('lastRoomId');
    // Ideally we should also tell the server we left, but socket.io handles disconnects.
    // If we want to leave the room without disconnecting, we'd need a 'leaveRoom' event.
    // For simplicity, we just unmount the component which disconnects/reconnects socket logic if handled there,
    // but since socket is global, we might need to emit a leave event or just reload.
    window.location.reload(); 
  };

  if (!joined) {
    return (
      <div className="container" style={{ justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <h1 style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🎤 YouTube Karaoke</h1>
        <p style={{ color: '#aaa', marginBottom: '3rem' }}>Enter a Room ID to start singing</p>
        
        <form onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: '20px', width: '100%', maxWidth: '400px' }}>
          <input 
            type="text" 
            value={inputRoomId}
            onChange={(e) => setInputRoomId(e.target.value)}
            placeholder="Room Number (e.g. 888)"
            style={{ fontSize: '1.5rem', textAlign: 'center', padding: '15px' }}
          />
          <button type="submit" className="btn-primary" style={{ fontSize: '1.2rem', padding: '15px' }}>
            Join Room 🚪
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="App">
      <Room roomId={roomId} onLeave={handleLeave} />
    </div>
  );
}

export default App;
