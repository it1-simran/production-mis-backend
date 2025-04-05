const mongoose = require("mongoose");

const ReturnKitToStoreSchema = new mongoose.Schema(
  {
    processId: {
    type: mongoose.Schema.Types.ObjectId,
        ref: "processes",
        required: true,
    },
    returnedKits: {type: Number, default:0},
    returnedCarton: {type: Number, default: 0},
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status:{ 
        type: String,
        required: true,
        enum: ["SEND_TO_STORE","PARTIALLY_RECIVED","RECIVED"]
    },
    createdAt: {type: Date, default: Date.now},
    updatedAt: {type: Date, default: Date.now},
  },
  { timestamps: true }
);

const returnKitToStore = mongoose.model("returnKitToStore", ReturnKitToStoreSchema);
module.exports = returnKitToStore;
