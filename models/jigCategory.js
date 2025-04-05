const mongoose = require('mongoose');

const jigCategorySchema = new mongoose.Schema({
    name: { type: String, required: true },
    status : { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

// Creating the model from schema
const jigCategory = mongoose.model('jigCategory', jigCategorySchema);

module.exports = jigCategory;
