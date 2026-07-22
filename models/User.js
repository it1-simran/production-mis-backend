const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  employeeCode: { type: String, required: true, unique: true },
  // sparse: true so that documents WITHOUT an email don't collide on the unique index
  email: { type: String, default: undefined, unique: true, sparse: true },
  mobileNo: { type: String, unique: true, sparse: true },
  gender: { type: String, required: true },
  password: { type: String, required: true },
  dateOfBirth: { type: Date, required: true },
  userType: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  profilePic: { type: String, default: "" },
  coverPic: { type: String, default: "" },
  skills: { type: [String], default: [] },
  department: { type: String, default: "" },
  status: { type: String, enum: ['Active', 'Inactive', 'Discarded'], default: 'Active' },
  deboardedAt: { type: Date, default: null },
  deboardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  deboardReason: { type: String, default: "" }
});

// Ensure email/mobileNo are never stored as empty string — must be a real value or absent
userSchema.pre('validate', function (next) {
  if (!this.email || String(this.email).trim() === '') {
    this.email = undefined;
  }
  if (!this.mobileNo || String(this.mobileNo).trim() === '') {
    this.mobileNo = undefined;
  }
  next();
});

const User = mongoose.model("User", userSchema);

// ---------------------------------------------------------------------------
// One-time startup fix: drop the old NON-SPARSE unique index on `email` if it
// still exists in MongoDB from a previous schema version.
//
// Without `sparse: true`, MongoDB treats every missing email as null, so the
// second operator created without an email would get a duplicate-key 11000
// error and the UI showed "A user with this email already exists".
//
// The schema now declares email as `unique + sparse`, so Mongoose will recreate
// it correctly. We just need to remove the old version first.
// ---------------------------------------------------------------------------
(async () => {
  try {
    const indexes = await User.collection.indexes();
    for (const idx of indexes) {
      const fields = Object.keys(idx.key || {});
      if (
        fields.length === 1 &&
        fields[0] === 'email' &&
        idx.unique === true &&
        !idx.sparse
      ) {
        await User.collection.dropIndex(idx.name);
        console.log('[User] Dropped stale non-sparse email index:', idx.name);
        break;
      }
    }
  } catch (err) {
    // Non-fatal — the index may already be gone or the collection may not exist yet
    console.warn('[User] Email index migration warning:', err.message);
  }
})();

module.exports = User;
