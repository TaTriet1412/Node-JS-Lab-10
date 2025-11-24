require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- 1. KẾT NỐI MONGODB (Yêu cầu nâng cao) ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/lab10_chat')
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.log(err));

// Schema lưu tin nhắn
const MessageSchema = new mongoose.Schema({
    sender: String,
    receiver: String,
    content: String,
    type: { type: String, default: 'text' }, // 'text' hoặc 'image'
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', MessageSchema);

// --- 2. CẤU HÌNH APP & PASSPORT ---
app.set('view engine', 'ejs');
app.use(express.static('public')); // Để load CSS/JS trong file HTML cũ
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());

// Cấu hình Google Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback"
  },
  function(accessToken, refreshToken, profile, cb) {
    // YÊU CẦU ĐỀ BÀI: Chỉ cho phép email sinh viên TDTU
    const email = profile.emails[0].value;
    if (email.endsWith('@student.tdtu.edu.vn')) {
        return cb(null, profile);
    } else {
        // Trả về lỗi nếu không phải email sinh viên TDTU
        return cb(new Error("Chỉ chấp nhận email sinh viên TDTU (@student.tdtu.edu.vn)!"));
    }
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Middleware kiểm tra đăng nhập
const isAuth = (req, res, next) => {
    if (req.isAuthenticated()) return next();
    res.redirect('/login');
}

// --- 3. ROUTES ---
app.get('/login', (req, res) => {
    res.render('login');
});

// Route kích hoạt đăng nhập Google
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  function(req, res) {
    res.redirect('/');
  });

// Add error handling for Google authentication
app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err) {
      // Redirect to login page with error message
      return res.redirect('/login?error=' + encodeURIComponent(err.message));
    }
    if (!user) {
      return res.redirect('/login');
    }
    req.logIn(user, (err) => {
      if (err) {
        return next(err);
      }
      return res.redirect('/');
    });
  })(req, res, next);
});

app.get('/', isAuth, (req, res) => {
    res.render('index', { user: req.user });
});

app.get('/chat', isAuth, async (req, res) => {
    const partnerId = req.query.partner;
    // Lấy lịch sử chat (Yêu cầu nâng cao)
    const history = await Message.find({
        $or: [
            { sender: req.user.emails[0].value, receiver: partnerId },
            { sender: partnerId, receiver: req.user.emails[0].value }
        ]
    }).sort({ timestamp: 1 });

    // Get partner info from online users if available
    let partnerInfo = null;
    if (onlineUsers[partnerId]) {
        partnerInfo = {
            name: onlineUsers[partnerId].name,
            email: onlineUsers[partnerId].email,
            avatar: onlineUsers[partnerId].avatar
        };
    }

    res.render('chat', { 
        user: req.user, 
        partnerId: partnerId, 
        history: history,
        partnerInfo: partnerInfo
    });
});

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/login');
    });
});

// --- 4. XỬ LÝ SOCKET.IO (REALTIME) ---
let onlineUsers = {}; // Lưu danh sách user
let disconnectTimers = {}; // Lưu các bộ đếm thời gian chờ thoát

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);

    // --- Xử lý khi User Online (từ trang Index) ---
    socket.on('user_connected', (userData) => {
        socket.email = userData.email; 
        
        // 1. Nếu user này đang trong danh sách chờ xóa (do vừa reload/chuyển trang), thì HỦY xóa
        if (disconnectTimers[userData.email]) {
            clearTimeout(disconnectTimers[userData.email]);
            delete disconnectTimers[userData.email];
        }

        // 2. Cập nhật thông tin và set trạng thái Available
        onlineUsers[userData.email] = {
            socketId: socket.id,
            name: userData.name,
            avatar: userData.photo,
            email: userData.email,
            status: 'Available',
            chattingWith: null // Thêm thuộc tính để biết đang chat với ai
        };

        // 3. Gửi danh sách mới cho mọi người
        io.emit('update_user_list', Object.values(onlineUsers));
        
        // Chỉ thông báo "Vừa mới online" nếu đây là kết nối mới hoàn toàn (không phải do F5)
        // (Logic này tùy chọn, nhưng để đơn giản ta cứ broadcast notification như cũ)
        socket.broadcast.emit('user_online_notification', {
            name: userData.name,
            email: userData.email
        });
    });

    // SỬA LẠI sự kiện join_chat
    socket.on('join_chat', (data) => {
        const { myEmail, partnerEmail } = data;
        socket.email = myEmail;

        // Hủy timer disconnect nếu có (code fix lỗi f5 trước đó)
        if (disconnectTimers[myEmail]) {
            clearTimeout(disconnectTimers[myEmail]);
            delete disconnectTimers[myEmail];
        }

        if (onlineUsers[myEmail]) {
            onlineUsers[myEmail].socketId = socket.id;
            onlineUsers[myEmail].status = 'Busy';
            onlineUsers[myEmail].chattingWith = partnerEmail; // <--- THÊM DÒNG NÀY: Lưu đang chat với ai
        }

        // Cập nhật danh sách cho mọi người
        io.emit('update_user_list', Object.values(onlineUsers));

        // (Tùy chọn) Gửi thông báo riêng cho người nhận để hiện popup
        const partner = onlineUsers[partnerEmail];
        if (partner) {
            io.to(partner.socketId).emit('incoming_chat', { 
                senderEmail: myEmail,
                senderName: onlineUsers[myEmail].name 
            });
        }
    });

    // SỬA LẠI sự kiện leave_chat
    socket.on('leave_chat', (myEmail) => {
        if(onlineUsers[myEmail]) {
            onlineUsers[myEmail].status = 'Available';
            onlineUsers[myEmail].chattingWith = null; // <--- THÊM DÒNG NÀY: Xóa người đang chat cùng
            io.emit('update_user_list', Object.values(onlineUsers));
        }
    });

    // --- Xử lý Gửi tin nhắn ---
    socket.on('send_message', async (data) => {
        // Lưu DB
        const newMsg = new Message({
            sender: data.sender,
            receiver: data.receiver,
            content: data.content,
            type: data.type || 'text'
        });
        await newMsg.save();

        const receiver = onlineUsers[data.receiver];
        if (receiver) {
            io.to(receiver.socketId).emit('receive_message', data);
        }
    });
    
    // --- Xử lý Đang soạn tin ---
    socket.on('typing', (data) => {
       const receiver = onlineUsers[data.receiver];
       if(receiver) io.to(receiver.socketId).emit('typing', data);
    });
    socket.on('stop_typing', (data) => {
       const receiver = onlineUsers[data.receiver];
       if(receiver) io.to(receiver.socketId).emit('stop_typing', data);
    });


    // --- Xử lý Ngắt kết nối (QUAN TRỌNG NHẤT) ---
    socket.on('disconnect', () => {
        const email = socket.email;
        if (email && onlineUsers[email]) {
            // THAY VỊ XÓA NGAY, TA CHỜ 3 GIÂY
            disconnectTimers[email] = setTimeout(() => {
                const userData = onlineUsers[email];
                
                // Xóa user
                delete onlineUsers[email];
                
                // Xóa timer
                delete disconnectTimers[email];

                // Cập nhật danh sách
                io.emit('update_user_list', Object.values(onlineUsers));
                
                // Gửi thông báo Offline
                io.emit('user_offline_notification', {
                    name: userData.name,
                    email: userData.email
                });
                
                console.log(`User ${email} disconnected permanently.`);
            }, 3000); // Chờ 3000ms (3 giây)
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));