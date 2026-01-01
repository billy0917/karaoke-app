const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const yts = require('yt-search');
const fs = require('fs');
const https = require('https');

if (!process.env.APIPLUS_API_KEY) {
  console.warn('[server] APIPLUS_API_KEY is not set; /api/ai/parse-song will return 500');
}

const app = express();
app.use(cors());
app.use(express.json());

// In-memory capability cache for the upstream AI provider.
// Avoids repeated paid calls caused by trying unsupported parameters over and over.
const AI_UNSUPPORTED_PARAMS = new Set();

function httpsJsonPost(urlString, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = JSON.stringify(body ?? {});
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, headers: res.headers, text: data });
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function extractFirstJsonObject(text) {
  if (!text) return null;
  const s = String(text);
  // Strip common markdown code fences
  const unfenced = s.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '');
  const match = unfenced.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

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

// AI: parse a music query from YouTube title/author
app.post('/api/ai/parse-song', async (req, res) => {
  const apiKey = process.env.APIPLUS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Missing APIPLUS_API_KEY on server' });
  }

  function clipText(s, maxLen) {
    const t = typeof s === 'string' ? s : '';
    if (!t) return '';
    const trimmed = t.trim();
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen);
  }

  // Clip inputs to keep prompts small and predictable.
  const title = clipText(req.body?.title, 200);
  const author = clipText(req.body?.author, 120);
  if (!title && !author) {
    return res.status(400).json({ error: 'Missing title/author' });
  }

  const model = process.env.APIPLUS_MODEL || 'gpt-5-nano-2025-08-07';
  const maxTokensEnvRaw = process.env.APIPLUS_MAX_TOKENS;
  const maxTokensEnv = maxTokensEnvRaw ? parseInt(String(maxTokensEnvRaw), 10) : NaN;
  const maxTokens = Number.isFinite(maxTokensEnv) && maxTokensEnv > 0 ? maxTokensEnv : null;

  function buildPayload({ short = false, withResponseFormat = true } = {}) {
    // Keep prompts extremely short to reduce provider-side "reasoning" spend.
    // Goal: a tiny JSON object only.
    const system =
      'Output ONLY minified JSON with exactly these keys: {"trackName":"","artistName":""}. ' +
      'artistName MUST be the empty string. No other text.';

    const user =
      (short ? 'Extract trackName for lyrics search.' : 'Extract trackName for lyrics search.') +
      ' Rules: remove bracketed info (e.g. () [] 【】), remove words like Official/Lyrics/MV/Live/HD/4K. ' +
      'If title has Chinese+English, return ONLY the Chinese title (no English subtitle). ' +
      `title="${title}" author="${author}"`;

    const payload = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      reasoning: { effort: 'low' },
      temperature: 0,
      top_p: 1,
      presence_penalty: 0,
      frequency_penalty: 0,
    };

    // By default we do NOT send max token limits (user preference).
    // If you want a hard cap for cost control, set APIPLUS_MAX_TOKENS.
    if (maxTokens && !AI_UNSUPPORTED_PARAMS.has('max_tokens')) {
      payload.max_tokens = maxTokens;
    }
    if (maxTokens && !AI_UNSUPPORTED_PARAMS.has('max_completion_tokens')) {
      payload.max_completion_tokens = maxTokens;
    }

    if (withResponseFormat && !AI_UNSUPPORTED_PARAMS.has('response_format')) {
      // OpenAI-compatible strict JSON mode (if supported by provider).
      payload.response_format = { type: 'json_object' };
    }

    if (AI_UNSUPPORTED_PARAMS.has('reasoning')) {
      delete payload.reasoning;
    }

    if (AI_UNSUPPORTED_PARAMS.has('max_tokens')) {
      delete payload.max_tokens;
    }
    if (AI_UNSUPPORTED_PARAMS.has('max_completion_tokens')) {
      delete payload.max_completion_tokens;
    }

    return payload;
  }

  async function callAi(payload) {
    const { status, text } = await httpsJsonPost(
      'https://api.apiplus.org/v1/chat/completions',
      payload,
      {
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'karaoke-app/1.0',
      }
    );
    return { status, text };
  }

  function getUnknownParamName(text) {
    try {
      const j = JSON.parse(text);
      const param = j?.error?.param;
      return typeof param === 'string' ? param : '';
    } catch {
      return '';
    }
  }

  function stripParam(payload, paramName) {
    if (!paramName || typeof payload !== 'object' || payload === null) return payload;
    const clone = { ...payload };
    if (Object.prototype.hasOwnProperty.call(clone, paramName)) {
      delete clone[paramName];
    }
    // Some providers treat nested objects as unknown too; keep it minimal.
    return clone;
  }

  async function callAiOnceWithOptionalRetry(initialPayload) {
    // At most 1 retry: if provider says a parameter is unknown, remember it and retry.
    let payload = initialPayload;
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await callAi(payload);
      if (out.status >= 200 && out.status < 300) return { ...out, payloadUsed: payload };

      if (out.status === 400) {
        const unknown = getUnknownParamName(out.text);
        if (unknown) {
          AI_UNSUPPORTED_PARAMS.add(unknown);
          payload = stripParam(payload, unknown);
          continue;
        }
      }

      return { ...out, payloadUsed: payload };
    }
    const out = await callAi(payload);
    return { ...out, payloadUsed: payload };
  }

  try {
    // Single call (max 1 retry on unknown param).
    let attempt = { payload: buildPayload({ short: false, withResponseFormat: true }), status: 0, text: '' };
    const out1 = await callAiOnceWithOptionalRetry(attempt.payload);
    attempt = { payload: out1.payloadUsed, status: out1.status, text: out1.text };

    if (attempt.status < 200 || attempt.status >= 300) {
      if (attempt.status === 429) {
        return res.status(429).json({ error: 'AI rate limited (429)', detail: attempt.text?.slice?.(0, 800) || '' });
      }
      return res.status(502).json({ error: `AI service error (${attempt.status})`, detail: attempt.text?.slice?.(0, 800) || '' });
    }

    function parseResponseText(respText) {
      let json = null;
      try {
        json = JSON.parse(respText);
      } catch {
        json = null;
      }

      const content =
        json?.choices?.[0]?.message?.content ||
        json?.choices?.[0]?.text ||
        '';

      const parsed = extractFirstJsonObject(content) || extractFirstJsonObject(respText);
      const trackName = typeof parsed?.trackName === 'string' ? parsed.trackName.trim() : '';
      const artistName = typeof parsed?.artistName === 'string' ? parsed.artistName.trim() : '';

      return { trackName, artistName, raw: String(content || respText || '').slice(0, 1200) };
    }

    const out = parseResponseText(attempt.text);

    // If upstream returned no usable output, surface it as a non-200 so the client
    // doesn't treat it as a successful parse.
    if (!out.trackName && !out.artistName) {
      return res.status(422).json({
        error: 'AI returned empty output',
        model,
        raw: out.raw,
      });
    }

    return res.json({ trackName: out.trackName, artistName: out.artistName, model, raw: out.raw });
  } catch (err) {
    console.error('AI parse-song error:', err?.message || err);
    return res.status(502).json({ error: 'AI service unavailable' });
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
