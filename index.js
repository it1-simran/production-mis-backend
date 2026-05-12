const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const dotenv = require('dotenv');
const morgan = require('morgan');
const compression = require('compression');

const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.development';
dotenv.config({ path: path.join(__dirname, envFile) });

const app = express();

app.use(helmet({
  contentSecurityPolicy: false,
})); 
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : '*';
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
app.use(compression());
app.use((req, res, next) => {
  const rid = req.get('x-request-id') || crypto.randomUUID();
  req.requestId = rid;
  res.setHeader('x-request-id', rid);
  next();
});
app.use(morgan('dev')); // HTTP request logger
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Example Route
app.get('/', (req, res) => {
  res.send(`Production MIS Backend is running in ${process.env.NODE_ENV} mode`);
});

// Import Routes
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes);

app.use('/api/*', (req, res) => {
  res.status(404).json({ status: 404, message: `API route not found: ${req.method} ${req.originalUrl}` });
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(">>> [GLOBAL ERROR]:", err.stack || err.message || err);
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    status,
    message: err.message || "Something went wrong!",
    ...(process.env.NODE_ENV !== "production" ? { stack: err.stack } : {}),
  });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('>>> [UNHANDLED REJECTION]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('>>> [UNCAUGHT EXCEPTION]:', err);
  process.exit(1);
});

// Define the port
const PORT = process.env.PORT || 4000;

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server is running in ${process.env.NODE_ENV} mode on port ${PORT}`);
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('WARNING: JWT_SECRET is not set. Using insecure default. Set JWT_SECRET in .env.production');
  }
});

// Set global timeout to 2 minutes (120000ms)
server.timeout = 120000;
server.keepAliveTimeout = 121000; // Keep slightly larger than timeout
server.headersTimeout = 122000; // Keep slightly larger than keepAliveTimeout
