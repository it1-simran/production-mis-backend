const mongoose = require("mongoose");

const esimApnSchema = new mongoose.Schema({
    apnName: { type: String, required: true },
    esimMake: { type: String, required: true },
    esimProfile1: { type: String, required: true },
    activeStatus: { type: Boolean, default: true },
    remarks: { type: String, required: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("EsimApn", esimApnSchema);
