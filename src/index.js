import { db } from './db/index.js';
import { users, rooms } from './db/schema.js';

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import session from 'express-session';
import passport from 'passport';
import './config/passport.js'; // this loads passport config
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';


const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === 'production';
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
const configuredOrigins = (process.env.FRONTEND_URLS || frontendUrl)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = isProduction
  ? configuredOrigins
  : [...new Set([...configuredOrigins, 'http://localhost:5173'])];

const generateRoomCode = () => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
};

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
}));

app.use(express.json());  // parse json bodies
app.use(express.urlencoded({ extended: true }));  // parse from data

app.use(session({
  secret: process.env.SESSION_SECRET,
  proxy: true,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    httpOnly: true
  }
}));

app.use(passport.initialize());
app.use(passport.session());

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});


// Store room state and users in memory
const roomState = new Map();
const roomUsers = new Map(); // map of roomid -> map of socketid -> username

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (data) => {
    const { roomId, username, userId} = data;
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

    roomUsers.get(roomId).set(socket.id, { name: username, userId: userId || null });
    
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
      socket.emit('server-error', { message: 'Message too long(max 500 characters)' });
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
        const { name: username } = users.get(socket.id);
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

app.get('/health', async (req, res) => {
  /*
  res.json({ status: 'ok',
    activeRooms: roomState.size,
    totalUsers: Array.from(roomUsers.values()).reduce((sum, users) => sum + users.size, 0)
   });
   */

   const allUsers = await db.select().from(users);
   const len = allUsers.length;
   res.json({
      status: 'healthy',
      database: 'connected',
      userCount: len
   });
});

app.get('/dev/clear-users', async(req, res) => {
  const clearUsers = await db.delete(users);
  req.logout((err) => {
    res.json({
      message: 'All users deleted. You are now logged out',
      note: 'Refresh page'
    });
  });
});

app.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email']
  })
);

app.get('/auth/google/callback', 
  passport.authenticate('google', {
    successRedirect: '/auth/success',
    failureRedirect: frontendUrl
  })
);

app.get('/auth/success', (req, res) => {
  req.session.save((err) => {
    res.send(`
      <html>
        <body>
          <script>window.location.href = '${frontendUrl}';</script>
        </body>
      </html>
    `);
  });
});

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if(err) {
      return res.redirect(`${frontendUrl}/error`);
    }
    res.redirect(frontendUrl);
  });
});

app.get('/api/user', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if(req.user) { return res.json(req.user); }
  return res.json(null);
});

app.post('/auth/register', async (req, res) => {
  const { name, email, password } = req.body;
  const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existingUser.length > 0){
    return res.status(400).json({error: 'Email already exists'});
  }
  const hashedPassword = await bcrypt.hash(password, 10);
  // 10 is the "salt rounds" - higher = more secure but slower
  const newUser = await db.insert(users)
    .values({
      name: name,
      email: email,
      password: hashedPassword
    })
    .returning();
  res.json({ success: true, message: 'User created' });
});

app.post('/auth/login', async(req, res) => {
  const { email, password } = req.body;
  const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = existingUser[0];
  if (!user){
    return res.status(401).json({error: 'Invalid credentials'});
  } 
  if (!user.password) {
    return res.status(401).json({ error: 'Please use Google Sign In' });
  }
  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.login(user, (err) =>{
    if (err) {
      return res.status(500).json({ error: 'Login Failed' });
    }
    res.json({ success: true, user });
  });
})

app.post('/api/rooms/create', async(req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Must be logged in' });
  }
  const { name, roomType } = req.body;
  const roomName = name || `${req.user.name}'s Room`;
  let code;
  let isUnique = false;
  while(!isUnique) {
    code = generateRoomCode();
    const existing = await db.select().from(rooms).where(eq(rooms.code, code)).limit(1);
    if (existing.length === 0) {
      isUnique = true;
    }
  }

  const newRoom = await db.insert(rooms)
    .values({
      code: code,
      name: roomName,
      hostId: req.user.id,
      isTemporary: false,
      roomType: roomType || 'collaborative',
      maxCapacity: 10, // default
      isActive: true
    })
    .returning();

    res.json({ success: true, roomCode: code, roomName: roomName });
});

app.get('/api/rooms/:code', async (req, res) => {
  try {
    const { code } = req.params;
    console.log('Fetching room with code:', code);
    const room = await db
      .select({
        id: rooms.id,
        code: rooms.code,
        name: rooms.name,
        hostId: rooms.hostId,
        roomType: rooms.roomType,
        isTemporary: rooms.isTemporary,
        maxCapacity: rooms.maxCapacity,
        isActive: rooms.isActive,
        createdAt: rooms.createdAt,
        hostName: users.name  // ← This gets the host's name!
      })
      .from(rooms)
      .leftJoin(users, eq(rooms.hostId, users.id))  // ← Join the tables
      .where(eq(rooms.code, code))
      .limit(1);

    if (room.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    console.log('Found room:', room[0]);
    res.json(room[0]);
  } catch (error){
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Failed to fetch room'});
  }
});

app.patch('/api/rooms/:code', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({error: 'Must be logged in'});
  }

  const { code } = req.params;
  const { roomType } = req.body;

  if (!['collaborative', 'presentation'].includes(roomType)) {
    return res.status(400).json({error: 'Invalid room type' });
  }

  const room = await db.select().from(rooms).where(eq(rooms.code, code)).limit(1);
  if (room.length === 0) {
    return res.status(404).json({error: 'Room not found'});
  }

  if (room[0].hostId !== req.user.id) {
    return res.status(403).json({error: 'Only the host can change the room type'});
  }
  
  await db.update(rooms).set({ roomType }).where(eq(rooms.code, code));

  io.to(code).emit('room-type-changed', { roomType });
  res.json({ success: true, roomType });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check available at http://localhost:${PORT}/health`);
});