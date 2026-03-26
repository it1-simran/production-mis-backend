const express = require('express');
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
app.use(cors({
  origin: '*'
})); // Enable CORS
app.use(compression());
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

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(">>> [GLOBAL ERROR]:", err.stack || err.message || err);
  const status = err.statusCode || err.status || 500;
  const raw = String(err.message || "").trim();
  let safeMessage = "We couldn't complete your request. Please try again.";

  if (status === 400 || status === 422) {
    safeMessage = raw || "Please review the entered details and try again.";
  } else if (status === 401) {
    safeMessage = "Your session has expired. Please sign in again.";
  } else if (status === 403) {
    safeMessage = "You do not have permission to perform this action.";
  } else if (status === 404) {
    safeMessage = "The requested record was not found.";
  } else if (status === 409) {
    safeMessage = raw || "This action conflicts with existing data.";
  } else if (raw && raw.length <= 180 && !raw.includes(" at ")) {
    safeMessage = raw;
  }

  res.status(status).json({
    status,
    message: safeMessage,
    ...(process.env.NODE_ENV !== "production" ? { stack: err.stack } : {}),
  });
});

// Define the port
const PORT = process.env.PORT || 4000;

// Start the server
const server = app.listen(PORT, () => {
  console.log(`Server is running in ${process.env.NODE_ENV} mode on port ${PORT}`);
});

// Set global timeout to 2 minutes (120000ms)
server.timeout = 120000;
server.keepAliveTimeout = 121000; // Keep slightly larger than timeout
server.headersTimeout = 122000; // Keep slightly larger than keepAliveTimeout
