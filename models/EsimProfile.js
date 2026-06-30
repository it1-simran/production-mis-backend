const mongoose = require("mongoose");

const esimProfileSchema = new mongoose.Schema({
    profileId: { type: String, required: true, unique: true },
    name: { type: [String], required: true },
    activeStatus: { type: Boolean, default: true },
    remarks: { type: String, required: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

esimProfileSchema.index({ name: 1 });

module.exports = mongoose.model("EsimProfile", esimProfileSchema);
