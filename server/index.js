const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// If client is built (optional), serve it from this server.
// In方案A (GitHub Pages + Render), Render runs backend only, so client/dist may not exist.
const clientDistPath = path.join(__dirname, '../client/dist');
const clientIndexPath = path.join(clientDistPath, 'index.html');
if (fs.existsSync(clientDistPath) && fs.existsSync(clientIndexPath)) {
  app.use(express.static(clientDistPath));
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for now, restrict in production
    methods: ["GET", "POST"]
  }
});

// Persistence
const DATA_FILE = path.join(__dirname, 'rooms.json');

function loadRooms() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Error loading rooms:', err);
  }
  return {};
}

function saveRooms(rooms) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(rooms, null, 2));
  } catch (err) {
    console.error('Error saving rooms:', err);
  }
}

// In-memory rooms (initialized from file)
let rooms = loadRooms();

// Search Endpoint
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter' });
  }

  try {
    const searchResults = await yts(query);
    const videos = searchResults.videos.slice(0, 10).map(video => ({
      id: video.videoId,
      title: video.title,
      thumbnail: video.thumbnail,
      duration: video.timestamp,
      author: video.author.name
    }));

    res.json(videos);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Failed to search videos' });
  }
});

// Socket.io Events
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Join Room
  socket.on('joinRoom', (roomId) => {
    socket.join(roomId);
    socket.data.roomId = roomId;
    
    // Initialize room if not exists
    if (!rooms[roomId]) {
      rooms[roomId] = [];
      saveRooms(rooms);
    }
    
    // Send current queue to user
    socket.emit('queueUpdated', rooms[roomId]);
    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  // Add song to queue
  socket.on('addSong', (song) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const queue = rooms[roomId];
    // Add a unique ID to the song instance in the queue
    const queueItem = { ...song, uuid: Date.now() + Math.random().toString() };
    
    if (song.isTop && queue.length > 0) {
      // Insert after the currently playing song (index 1)
      queue.splice(1, 0, queueItem);
    } else {
      queue.push(queueItem);
    }
    
    saveRooms(rooms);
    io.to(roomId).emit('queueUpdated', queue);
    console.log(`[Room ${roomId}] Song added:`, song.title);
  });

  // Pin existing song to top (move to index 1)
  socket.on('pinSong', (uuid) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const queue = rooms[roomId];
    const songIndex = queue.findIndex(s => s.uuid === uuid);
    if (songIndex > 1) { // Only move if it's not already playing or at top
      const [song] = queue.splice(songIndex, 1);
      queue.splice(1, 0, song);
      saveRooms(rooms);
      io.to(roomId).emit('queueUpdated', queue);
    }
  });

  // Reorder queue (Drag and Drop)
  socket.on('reorderQueue', (newQueue) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const queue = rooms[roomId];
    // Ensure we don't mess up the currently playing song (index 0)
    if (queue.length > 0 && newQueue.length > 0 && queue[0].uuid === newQueue[0].uuid) {
        rooms[roomId] = newQueue;
        saveRooms(rooms);
        io.to(roomId).emit('queueUpdated', newQueue);
    }
  });

  // Volume control
  socket.on('volumeChange', (volume) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      io.to(roomId).emit('volumeChange', volume);
    }
  });

  // Remove song from queue
  socket.on('removeSong', (uuid) => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    rooms[roomId] = rooms[roomId].filter(song => song.uuid !== uuid);
    saveRooms(rooms);
    io.to(roomId).emit('queueUpdated', rooms[roomId]);
  });

  // Song finished or skipped (Play next)
  socket.on('songEnded', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const queue = rooms[roomId];
    if (queue.length > 0) {
      queue.shift(); // Remove the first song
      saveRooms(rooms);
      io.to(roomId).emit('queueUpdated', queue);
    }
  });

  // Skip current song
  socket.on('skipSong', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const queue = rooms[roomId];
    if (queue.length > 0) {
      queue.shift(); // Remove the first song
      saveRooms(rooms);
      io.to(roomId).emit('queueUpdated', queue);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Handle React routing (only when client is served by this server)
if (fs.existsSync(clientIndexPath)) {
  app.get('*', (req, res) => {
    res.sendFile(clientIndexPath);
  });
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
