const mongoose = require("mongoose");

// One row per v2 plan save, recording what the validator found. It exists so enforcement can be
// switched on from evidence ("how often would SEAT-001 have blocked a real save?"), not guesses.
// Independent of the plan collection; rows expire after 120 days.
//
// The schema's indexes are NOT built automatically (config/db.js runs with autoIndex:false).
// Run `node scripts/create-planning-indexes.js` once per environment.
const planValidationEventSchema = new mongoose.Schema({
  planId: { type: mongoose.Schema.Types.ObjectId, default: null },
  processId: { type: mongoose.Schema.Types.ObjectId, default: null },
  userId: { type: mongoose.Schema.Types.ObjectId, default: null },
  action: { type: String, enum: ["create", "update"], required: true },
  mode: { type: String, enum: ["off", "warn", "enforce"], required: true },
  validatorVersion: { type: String, default: "" },
  summary: {
    errors: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    info: { type: Number, default: 0 },
  },
  issues: [
    {
      _id: false,
      code: String,
      severity: String,
      seatKey: { type: String, default: "" },
      resourceType: { type: String, default: "" },
    },
  ],
  wouldHaveBlocked: { type: Boolean, default: false },
  blocked: { type: Boolean, default: false },
  overrideReason: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
});

planValidationEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 120 });
planValidationEventSchema.index({ planId: 1 });
planValidationEventSchema.index({ "issues.code": 1, createdAt: -1 });

module.exports = mongoose.model("planValidationEvent", planValidationEventSchema);
