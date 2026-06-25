// db.js
const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            autoIndex: true,
            maxPoolSize: 50,
            minPoolSize: 5,
            maxIdleTimeMS: 30000,
            socketTimeoutMS: 45000,
            serverSelectionTimeoutMS: 10000,
        });
        console.log('Connected !!');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err.message);
        process.exit(1);  // Exit the process with failure
    }
};

module.exports = connectDB;
