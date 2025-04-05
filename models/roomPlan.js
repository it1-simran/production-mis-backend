const mongoose = require("mongoose");

const RoomPlanSchema = new mongoose.Schema(
  {
    floorName: { type: String, required: true },
    lines: [
      {
        rowName: { type: String, required: true },
        seats: [
          {
            seatNumber:{ type: String, required: false },
            selected:{ type: Boolean, default: false },
            reserved:{ type: Boolean, default: false },
          },
        ],
      },
    ],
  },
  { timestamps: true } // Automatically adds createdAt and updatedAt fields
);

const RoomPlan = mongoose.model("RoomPlan", RoomPlanSchema);

module.exports = RoomPlan;
