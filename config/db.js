// db.js
const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            autoIndex: true,
        });
        console.log('Connected !!');

        mongoose.connection.on('error', (err) => {
            console.error('MongoDB connection error:', err.message);
        });
        mongoose.connection.on('disconnected', () => {
            console.warn('MongoDB disconnected. Attempting reconnect...');
        });
        mongoose.connection.on('reconnected', () => {
            console.log('MongoDB reconnected');
        });
    } catch (err) {
        console.error('Error connecting to MongoDB:', err.message);
        process.exit(1);
    }
};

module.exports = connectDB;
