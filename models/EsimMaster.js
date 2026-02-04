const mongoose = require("mongoose");

const esimMasterSchema = new mongoose.Schema({
    ccid: { type: String, required: true, unique: true },
    esimMake: { type: String, required: false },
    profile1: { type: String, required: false },
    profile2: { type: String, required: false },
    // Additional fields for flexibility as per "etc"
    remarks: { type: String, required: false },

    isEditable: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("EsimMaster", esimMasterSchema);
