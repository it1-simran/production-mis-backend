// db.js
const mongoose = require('mongoose');

const connectDB = async () => {
    try {
        await mongoose.connect('mongodb+srv://jsddev:x262TbqjMpNYBY*@production-mis.w6l8d.mongodb.net/production-mis?retryWrites=true&w=majority', {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('Connected !!');
    } catch (err) {
        console.error('Error connecting to MongoDB:', err.message);
        process.exit(1);  // Exit the process with failure
    }
};

module.exports = connectDB;
