const mongoose = require("mongoose");

const esimMakeSchema = new mongoose.Schema({
    simId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    activeStatus: { type: Boolean, default: true },
    remarks: { type: String, required: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

esimMakeSchema.index({ name: 1 });

module.exports = mongoose.model("EsimMake", esimMakeSchema);
