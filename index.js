const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://splitstream-frontend.vercel.app"
    ], 
    methods: ["GET", "POST"]
  }
});

app.use(cors({
  origin: [
    "http://localhost:5173",
    "https://splitstream-frontend.vercel.app"
  ]
}));

// Store room state and users in memory
const roomState = new Map();
const roomUsers = new Map(); // map of roomid -> map of socketid -> username

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (data) => {
    const { roomId, username} = data;
    console.log(`User ${socket.id} joining room: ${roomId}`);
    
    socket.join(roomId);
    
    if (!roomState.has(roomId)) {
      roomState.set(roomId, {
        videoUrl: '',
        isPlaying: false,
        currentTime: 0,
        messages: []
      });
    }

    if (!roomUsers.has(roomId)) {
      roomUsers.set(roomId, new Map());
    }

    roomUsers.get(roomId).set(socket.id, username);
    
    const state = roomState.get(roomId);
    const users = Array.from(roomUsers.get(roomId).values());

    socket.emit('room-state', {
      ...state,
      users
    });

    socket.to(roomId).emit('user-joined', {
      username, users
    });
    console.log(`Sent room state to ${socket.id}:`, state);
    console.log(`Users in room ${roomId}:`, users);
  });

  socket.on('load-video', (data) => {
    const { roomId, videoUrl } = data;
    console.log(`Loading video in room ${roomId}: ${videoUrl}`);

    // yt url validation
    const ytRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
    if (!ytRegex.test(videoUrl)) {
      socket.emit('error', { message: 'Invalid Youtube URL' });
      return;
    }
    
    const state = roomState.get(roomId);
    if (state) {
      roomState.set(roomId, {
        ...state,
        videoUrl: videoUrl,
        isPlaying: false,
        currentTime: 0
      });
    } else {
      roomState.set(roomId, {
        videoUrl: videoUrl,
        isPlaying: false,
        currentTime: 0,
        messages: []
      });
    }
    
    io.to(roomId).emit('video-loaded', { videoUrl });
    console.log(`Broadcasted video-loaded to everyone in room ${roomId}`);
  });

  socket.on('play-video', (data) => {
    const { roomId, timestamp } = data;
    console.log(`Play video in room ${roomId} at timestamp ${timestamp}`);
    
    const state = roomState.get(roomId);
    if (state) {
      roomState.set(roomId, {
        ...state,
        isPlaying: true,
        currentTime: timestamp
      });

      // broadcast to everyone EXCEPT the person pressing play
      socket.to(roomId).emit('video-play', { timestamp });
      console.log(`Broadcasted video-play to others in room ${roomId}`);
    }
  });

  socket.on('pause-video', (data) => {
    const { roomId, timestamp } = data;
    console.log(`Pause video in room ${roomId} at timestamp ${timestamp}`);
    
    const state = roomState.get(roomId);
    if (state) {
      roomState.set(roomId, {
        ...state,
        isPlaying: false,
        currentTime: timestamp
      });

      // Broadcast to everyone EXCEPT the person who pressed pause
      socket.to(roomId).emit('video-pause', { timestamp });
      console.log(`Broadcasted video-pause to others in room ${roomId}`);
    }
  });

  socket.on('seek-video', (data) => {
    const { roomId, timestamp } = data;
    console.log(`Seek video in room ${roomId} to timestamp ${timestamp}`);

    const state = roomState.get(roomId);
    if (state) {
      roomState.set(roomId, {
        ...state,
        currentTime: timestamp
      });

      // Broadcast to everyone EXCEPT the person who pressed pause
      socket.to(roomId).emit('video-seek', { timestamp });
      console.log(`Broadcasted video-seek to others in room ${roomId}`);
    }
  });

  // Handle send-message event
  socket.on('send-message', (data) => {
    const { roomId, username, message, timestamp } = data;
    console.log(`Message from ${username} in room ${roomId}: ${message}`);

    // msg validation
    if (!message || message.trim().length === 0) {
      return;
    }
    if (message.length > 500) {
      socket.emit('error', { message: 'Message too long(max 500 characters)' });
      return;
    }
    
    const state = roomState.get(roomId);
    if (state) {
      const messageObject = {
        username,
        message,
        timestamp
      };
      
      // Add message to room's messages array
      state.messages = state.messages || [];
      state.messages.push(messageObject);
      roomState.set(roomId, state);
      
      // Broadcast message to everyone in the room
      io.to(roomId).emit('receive-message', messageObject);
      console.log(`Broadcasted message to everyone in room ${roomId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);

    // find which room user was in and remove them
    roomUsers.forEach((users, roomId) => {
      if (users.has(socket.id)) {
        const username = users.get(socket.id);
        users.delete(socket.id);

        const remainingUsers = Array.from(users.values());

        io.to(roomId).emit('user-left', {
          username,
          users: remainingUsers
        });

        console.log(`${username} left room ${roomId} Remaning users:`, remainingUsers);

        // clean up empty rooms
        if(users.size === 0) {
          roomUsers.delete(roomId);
          roomState.delete(roomId);
          console.log(`Room ${roomId} is empty and has been cleaned up`);
        }
      }
    });
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok',
    activeRooms: roomState.size,
    totalUsers: Array.from(roomUsers.values()).reduce((sum, users) => sum + users.size, 0)
   });
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});