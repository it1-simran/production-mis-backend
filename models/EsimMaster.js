const mongoose = require("mongoose");

const esimMasterSchema = new mongoose.Schema({
    ccid: { type: String, required: true, unique: true },
    esimMake: { type: String, required: false },
    profile1: { type: String, required: false },
    profile2: { type: String, required: false },
    apnProfile1: { type: String, required: false },
    apnProfile2: { type: String, required: false },
    remarks: { type: String, required: false },
    isEditable: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

esimMasterSchema.index({ createdAt: -1 });
esimMasterSchema.index({ esimMake: 1 });

module.exports = mongoose.model("EsimMaster", esimMasterSchema);