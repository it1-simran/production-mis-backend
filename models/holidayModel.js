const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema({
    holidayName: { type: String, required: true },
    holidayDate : { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

// Creating the model from schema
const holiday = mongoose.model('holiday', holidaySchema);

module.exports = holiday;
