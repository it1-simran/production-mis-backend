const mongoose = require('mongoose');

const jigSchema = new mongoose.Schema({
    name: { type: String, required: true },
    jigCategory : {type: mongoose.Schema.Types.ObjectId, ref: "jigcategories" },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

// Creating the model from schema
const Jig = mongoose.model('jigs', jigSchema);

module.exports = Jig;
