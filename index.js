const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const morgan = require('morgan');

dotenv.config();

const app = express();

app.use(cors()); // Enable CORS
app.use(bodyParser.json()); // Parse JSON request bodies
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded request bodies
app.use(morgan('dev')); // HTTP request logger
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// Example Route
app.get('/', (req, res) => {
  res.send('Hello, world!');
});

// Import Routes
const apiRoutes = require('./routes/api');
app.use('/api', apiRoutes);

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send({ error: 'Something went wrong!' });
});

// Define the port
const PORT = process.env.PORT || 8000;

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
